import { getChannels, type AuthenticatedLnd } from "lightning";
import { JsonStore } from "../store.js";

/**
 * How long each channel's peer has been offline (review
 * a3-channels:offline-means-force-close, package P4).
 *
 * Before, "offline" was a snapshot — `!c.active` the moment the close list was
 * built — scored as the strongest close signal, sorted to the top, and the
 * close dialog offered only a force-close for it. A Tor-only node sees short
 * peer disconnects all the time, so healthy channels were pushed toward the
 * most expensive way to close (commitment fee set in advance, anchor CPFP,
 * a sweep, and funds locked for the CSV delay).
 *
 * Now offline is a duration. LND's own per-channel counters (lifetime and
 * uptime) reset whenever LND restarts, so the robust source is ours: the
 * first time a channel was seen inactive in an unbroken series of
 * observations, persisted in DATA_DIR. Observations come every
 * OBSERVE_EVERY_MS while the app runs, and from every channel read the close
 * list and the Channels tab make. A gap longer than MAX_GAP_MS between two
 * observations (the app was down) breaks the series: the peer may have come
 * back meanwhile, so the count starts again — it can only ever undercount,
 * never push a channel toward a close early.
 *
 * LND's counters still add what they can prove: a channel LND has never seen
 * online since it started has been offline at least that long; and over
 * UPTIME_WINDOW_MS or more of monitoring, an uptime under MIN_UPTIME_SHARE is a
 * flaky peer whatever it does right now.
 */

/** Offline at least this long, continuously, before it counts toward a close. */
export const OFFLINE_CLOSE_SIGNAL_HOURS = 72;
/** LND's uptime counters must cover at least this long … */
export const UPTIME_WINDOW_MS = 14 * 86_400_000;
/** … and show less than this share online, to call the peer flaky. */
export const MIN_UPTIME_SHARE = 0.5;
/** How often channels are looked at while the app runs. */
export const OBSERVE_EVERY_MS = 10 * 60_000;
/** A longer gap between two observations breaks the "continuously offline" series. */
export const MAX_GAP_MS = 2 * 3_600_000;
/** The file is rewritten at most this often when nothing but the time changed. */
const PERSIST_EVERY_MS = 5 * 60_000;

interface UptimeState {
  /** The last observation (any channel). */
  lastObservedAt: string | null;
  /** Per channel id: since when it has been seen inactive without a break. */
  inactiveSince: Record<string, string>;
}

/** What the close list and the dialog know about a channel's peer being away. */
export interface OfflineInfo {
  /** Since when it has been offline without a break (null: online now). */
  since: string | null;
  /** How many hours that is (null: online now). */
  hours: number | null;
  /** LND's share of time online over its monitoring window, when that
   *  window is at least UPTIME_WINDOW_MS long (else null). */
  uptimeShare: number | null;
  /** Counts toward a close: offline ≥ OFFLINE_CLOSE_SIGNAL_HOURS, or a flaky
   *  peer (uptime < MIN_UPTIME_SHARE over ≥ 14 days). */
  long: boolean;
}

/** The channel fields this reads (a ChannelView fits). */
export interface UptimeChannel {
  id: string;
  active: boolean;
  status?: "open" | "pending_open" | "pending_close";
  /** LND's counters since it started monitoring the channel (ms). */
  timeOfflineMs?: number;
  timeOnlineMs?: number;
}

export class ChannelUptime {
  private readonly store: JsonStore<UptimeState>;
  private state: UptimeState;
  private persistedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    this.store = new JsonStore<UptimeState>(dataDir, "channel-uptime.json");
    const read = this.store.read({ lastObservedAt: null, inactiveSince: {} });
    this.state = {
      lastObservedAt: typeof read.lastObservedAt === "string" ? read.lastObservedAt : null,
      inactiveSince: read.inactiveSince && typeof read.inactiveSince === "object" ? { ...read.inactiveSince } : {},
    };
  }

  /**
   * Record what the channels look like now. Pending channels are not
   * channels the peer can be offline on yet; channels gone from the list
   * are forgotten.
   */
  observe(channels: readonly UptimeChannel[], nowMs = Date.now()): void {
    const last = this.state.lastObservedAt ? Date.parse(this.state.lastObservedAt) : NaN;
    const unbroken = Number.isFinite(last) && nowMs - last <= MAX_GAP_MS && nowMs >= last;
    const nowIso = new Date(nowMs).toISOString();
    const next: Record<string, string> = {};
    for (const c of channels) {
      if ((c.status ?? "open") !== "open" || c.active) continue;
      const had = this.state.inactiveSince[c.id];
      next[c.id] = unbroken && had ? had : nowIso;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.state.inactiveSince);
    this.state = { lastObservedAt: nowIso, inactiveSince: next };
    if (changed || nowMs - this.persistedAt >= PERSIST_EVERY_MS) {
      this.store.write(this.state);
      this.persistedAt = nowMs;
    }
  }

  /** Since when the channel has been seen inactive without a break, or null. */
  inactiveSince(channelId: string): string | null {
    return this.state.inactiveSince[channelId] ?? null;
  }

  /** What is known about the channel's peer being away (null: online now). */
  offlineInfo(c: UptimeChannel, nowMs = Date.now()): OfflineInfo | null {
    if ((c.status ?? "open") !== "open") return null;
    const off = c.timeOfflineMs ?? 0;
    const on = c.timeOnlineMs ?? 0;
    const window = off + on;
    const uptimeShare = window >= UPTIME_WINDOW_MS ? on / window : null;
    const flaky = uptimeShare !== null && uptimeShare < MIN_UPTIME_SHARE;
    if (c.active) return flaky ? { since: null, hours: null, uptimeShare, long: true } : null;
    // The earliest moment either source can vouch for: ours, or LND's when
    // it has never seen the peer online since it started monitoring.
    const ours = this.inactiveSince(c.id);
    const fromLnd = on === 0 && off > 0 ? nowMs - off : Infinity;
    const sinceMs = Math.min(ours ? Date.parse(ours) : Infinity, fromLnd);
    const hours = Number.isFinite(sinceMs) ? Math.max(0, (nowMs - sinceMs) / 3_600_000) : 0;
    return {
      since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : new Date(nowMs).toISOString(),
      hours: Math.round(hours * 10) / 10,
      uptimeShare,
      long: hours >= OFFLINE_CLOSE_SIGNAL_HOURS || flaky,
    };
  }

  /** Look at the channels every OBSERVE_EVERY_MS (a read; never keeps the
   *  process alive). */
  start(lnd: AuthenticatedLnd): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        const { channels } = await getChannels({ lnd });
        this.observe(channels.map((c) => ({ id: c.id, active: c.is_active })));
      } catch {
        // LND unreachable: no observation — the gap rule handles it.
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), OBSERVE_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** How long a peer has been away, in words ("5 h", "3 d"). */
export function offlineText(o: Pick<OfflineInfo, "hours" | "uptimeShare">): string {
  if (o.hours === null) return o.uptimeShare !== null ? `online only ${Math.round(o.uptimeShare * 100)}% of the time` : "online";
  return o.hours >= 48 ? `offline for ~${Math.round(o.hours / 24)} d` : `offline for ~${Math.max(1, Math.round(o.hours))} h`;
}

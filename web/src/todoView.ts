import type { ChannelView, DashboardData } from "./types";
import { satsCompact } from "./format";
import { offlineLabel } from "./closeView";
import { autopilotDigest, type DigestItem } from "./autopilotView";
import { refusalDigest } from "./magmaView";
import { noForwardsIn7d } from "./analyticsView";

/**
 * The start page's list: what needs you today, each line leading to where it
 * is dealt with. What needs you first (`warn`); what is merely under way after
 * it. Nothing here is news an operator can do nothing about: an autopilot run
 * that changed nothing is a footnote, not a task.
 */
export interface TodoItem {
  key: string;
  text: string;
  warn: boolean;
  /** Where the line leads: a node's details, or a tab. */
  node?: { pubkey: string; alias: string };
  tab?: string;
  sub?: string;
}

/** Peers named one by one before the rest become a count. */
const NAMED_OFFLINE = 3;

/** Lines with the same trouble become one: on a read-only node all four areas
 *  report the same "write mode is off". */
function foldSameTrouble(items: DigestItem[]): DigestItem[] {
  const out: DigestItem[] = [];
  const groups = new Map<string, { index: number; labels: string[]; verb: string; why: string }>();
  for (const it of items) {
    const m = it.key.startsWith("ap-") ? /^(.*?) (blocked|failed): (.*)$/.exec(it.text) : null;
    if (!m) {
      out.push(it);
      continue;
    }
    const [, label, verb, why] = m;
    const id = `${verb}:${why}`;
    const seen = groups.get(id);
    if (seen) {
      seen.labels.push(label);
      out[seen.index] = { ...out[seen.index], text: `${seen.labels.join(", ")} ${verb}: ${why}` };
    } else {
      groups.set(id, { index: out.length, labels: [label], verb, why });
      out.push(it);
    }
  }
  return out;
}

export function todoItems(d: DashboardData, channels: readonly ChannelView[] | null | undefined, nowMs = Date.now()): { todo: TodoItem[]; footnote: string | null } {
  const todo: TodoItem[] = [];

  // A peer away for days: coins that can't move. Biggest stake first.
  const away = (channels ?? [])
    .filter((c) => c.status === "open" && !c.active && c.offline?.long)
    .sort((a, b) => b.localBalance - a.localBalance);
  for (const c of away.slice(0, NAMED_OFFLINE)) {
    todo.push({
      key: `away-${c.id}`,
      text: `${c.peerAlias} is ${offlineLabel(c.offline) ?? "offline"}: ${satsCompact(c.localBalance)} sat of yours can't move`,
      warn: true,
      node: { pubkey: c.peerPubkey, alias: c.peerAlias },
    });
  }
  if (away.length > NAMED_OFFLINE) {
    todo.push({ key: "away-more", text: `${away.length - NAMED_OFFLINE} more channels offline for days`, warn: true, tab: "channels" });
  }

  // The autopilot: only what needs someone. The last run's news is the footnote.
  let footnote: string | null = null;
  const digest = foldSameTrouble(autopilotDigest(d.autopilot, nowMs));
  for (const it of digest) {
    if (it.key === "ap" && !it.warn) footnote = it.text;
    else if (it.key === "ap-last") footnote = footnote ? `${footnote} · ${it.text}` : it.text;
    else todo.push({ key: it.key, text: it.text, warn: it.warn ?? true, tab: it.tab ?? "autopilot", sub: it.sub });
  }

  if (noForwardsIn7d(d)) {
    todo.push({ key: "noflow", text: "No forwards in 7 days: check fees and liquidity", warn: true, tab: "autopilot", sub: "fees" });
  }
  const refusals = refusalDigest(d.autopilot.magmaRefusals, d.autopilot.magmaRefusalReason);
  if (refusals) todo.push({ key: "magma-refusals", text: refusals, warn: true, tab: "market", sub: "orders" });

  if (d.idleChannels && d.idleChannels.count > 0) {
    const n = d.idleChannels.count;
    todo.push({
      key: "idle",
      text: `${n} channel${n === 1 ? "" : "s"} routed nothing in ${d.windowDays} days: ${satsCompact(d.idleChannels.localSats)} sat of yours sit idle`,
      warn: false,
      tab: "channels",
    });
  }

  const opening = channels?.filter((c) => c.status === "pending_open").length ?? 0;
  const closing = channels?.filter((c) => c.status === "pending_close").length ?? 0;
  if (opening > 0) todo.push({ key: "popen", text: `${opening} channel${opening === 1 ? "" : "s"} opening: waiting for confirmation`, warn: false, tab: "channels" });
  if (closing > 0) todo.push({ key: "pclose", text: `${closing} channel${closing === 1 ? "" : "s"} closing`, warn: false, tab: "channels" });

  return { todo: [...todo.filter((t) => t.warn), ...todo.filter((t) => !t.warn)], footnote };
}

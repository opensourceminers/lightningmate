import type { ChannelForwardStat, ChannelView, NodeAssessment, NodeChannelFacts, NodeClosedChannel, NodeDetail, NodeEvent, NodeNetwork, PublicNodeRecord } from "./types";
import { sats, satsCompact } from "./format";
import { daysText, leaseTag, offlineLabel } from "./closeView";

/**
 * The words of a node's details and of the Channels table, apart from the
 * components so they can be tested: first what matters in one sentence, the
 * figures after it.
 */

export type Tone = "good" | "warn" | "neutral";

/** "430 ppm (0.043 %)": ppm is what the network speaks, a percent what anyone can read. */
export function ppmText(ppm: number): string {
  const pct = (ppm / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `${ppm.toLocaleString("en-US")} ppm (${pct} %)`;
}

/** "1.20 BTC" from 0.1 BTC up, else in sat. */
export function capacityText(value: number): string {
  return value >= 10_000_000 ? `${(value / 100_000_000).toFixed(2)} BTC` : `${satsCompact(value)} sat`;
}

/** "3 days", "5 months", "2.1 years" (null: not known). */
export function ageText(days: number | null): string | null {
  if (days === null || !Number.isFinite(days)) return null;
  if (days < 1) return "less than a day";
  if (days < 2) return "1 day";
  if (days < 60) return `${Math.floor(days)} days`;
  if (days < 730) return `${Math.floor(days / 30.44)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/** "~12 d", "~5 h", "~20 min" since a moment (null: not known). */
export function sinceText(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = ms / 3_600_000;
  if (hours >= 48) return `~${Math.round(hours / 24)} d`;
  if (hours >= 1) return `~${Math.round(hours)} h`;
  return `~${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** How a node can be reached, from the addresses it announces. */
export function reachText(n: Pick<NodeNetwork, "hasClearnet" | "hasOnion">): string {
  if (n.hasClearnet && n.hasOnion) return "Tor and clearnet";
  if (n.hasOnion) return "Tor only";
  if (n.hasClearnet) return "clearnet only";
  return "no address announced";
}

/** What the figures of all this node's channels add up to. */
export function channelTotals(facts: readonly NodeChannelFacts[]) {
  return {
    earnedSats: facts.reduce((sum, f) => sum + f.earnedSats, 0),
    broughtInSats: facts.reduce((sum, f) => sum + f.broughtInSats, 0),
    forwards: facts.reduce((sum, f) => sum + f.forwardsOut + f.forwardsIn, 0),
    refillFeeSats: facts.reduce((sum, f) => sum + f.refillFeeSats, 0),
  };
}

const firstUpper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The headline next to the name. */
export function nodeStatus(d: Pick<NodeDetail, "isSelf" | "channels" | "connection">, nowMs = Date.now()): { text: string; tone: Tone } {
  if (d.isSelf) return { text: "your node", tone: "neutral" };
  const open = d.channels.filter((c) => c.status === "open");
  if (open.length > 0) {
    const away = open.find((c) => !c.active);
    if (away) return { text: offlineLabel(away.offline) ?? "offline", tone: away.offline?.long ? "warn" : "neutral" };
    const since = sinceText(d.connection?.connectedSince ?? null, nowMs);
    return { text: since ? `online for ${since}` : "online", tone: "good" };
  }
  if (d.channels.some((c) => c.status === "pending_open")) return { text: "channel opening", tone: "neutral" };
  if (d.channels.some((c) => c.status === "pending_close")) return { text: "channel closing", tone: "neutral" };
  return { text: d.connection ? "connected, no channel" : "no channel", tone: "neutral" };
}

/**
 * The one sentence that says where you stand with this node. `a` is null while
 * the assessment hasn't arrived.
 */
export function nodeVerdict(
  d: Pick<NodeDetail, "isSelf" | "channels" | "channelFacts" | "forwardsKnown" | "closedChannels" | "windowDays">,
  a: Pick<NodeAssessment, "candidate" | "notSuggestedBecause"> | null,
): { text: string; tone: Tone } {
  if (d.isSelf) return { text: "This is your own node.", tone: "neutral" };

  if (d.channels.length === 0) {
    const closed = d.closedChannels[0];
    const before = closed ? ` You had a channel with it${closed.closedDaysAgo !== null ? `, closed ${closed.closedDaysAgo === 0 ? "recently" : `${closed.closedDaysAgo} days ago`}` : ""}.` : "";
    const c = a?.candidate;
    if (!a) return { text: `No channel with this node.${before}`, tone: "neutral" };
    if (!c) return { text: `No channel with this node. ${firstUpper(a.notSuggestedBecause[0] ?? "the network graph says little about it")}.${before}`, tone: "neutral" };
    // What keeps it off the list comes first: a score says little about a node
    // that hasn't been seen for a year, or has every channel switched off.
    if (a.notSuggestedBecause.length > 0) return { text: `Not suggested: ${a.notSuggestedBecause.join("; ")}.${before}`, tone: "warn" };
    const size = satsCompact(c.recommendedSizeSats);
    if (c.usefulness === "high") return { text: `Looks like a good peer for you: ${c.score}/100. About ${size} sat would fit.${before}`, tone: "good" };
    if (c.usefulness === "medium") return { text: `Could work as a peer: ${c.score}/100. About ${size} sat would fit.${before}`, tone: "neutral" };
    return { text: `Not a strong candidate for you: ${c.score}/100.${before}`, tone: "warn" };
  }

  const open = d.channels.filter((c) => c.status === "open");
  if (open.length === 0) {
    const local = d.channels.reduce((sum, c) => sum + c.localBalance, 0);
    if (d.channels.some((c) => c.status === "pending_open")) return { text: "A channel is opening: waiting for its transaction to confirm.", tone: "neutral" };
    // A force-close's coins wait out their time-lock, not just a confirmation.
    const lock = Math.max(0, ...d.channels.map((c) => c.timelockBlocks ?? 0));
    return {
      text: lock > 0 ? `A channel is closing: ${satsCompact(local)} sat come back on-chain after ${lock} more blocks (${daysText(lock)}).` : `A channel is closing: ${satsCompact(local)} sat come back on-chain once it confirms.`,
      tone: "neutral",
    };
  }

  const away = open.find((c) => !c.active);
  if (away) {
    const stuck = open.filter((c) => !c.active).reduce((sum, c) => sum + c.localBalance, 0);
    const how = offlineLabel(away.offline) ?? "offline";
    return away.offline?.long
      ? { text: `${firstUpper(how)}: ${satsCompact(stuck)} sat of yours can't move until it is back or the channel is closed.`, tone: "warn" }
      : { text: `${firstUpper(how)}. Short outages are common over Tor and usually end on their own.`, tone: "neutral" };
  }

  if (!d.forwardsKnown) return { text: "Online. The forwarding history couldn't be read in full, so what it earned is left out here.", tone: "neutral" };

  const t = channelTotals(d.channelFacts);
  const days = d.windowDays;
  if (t.forwards === 0) {
    const local = open.reduce((sum, c) => sum + c.localBalance, 0);
    // Only the open channels' ages: one still opening has none.
    const ages = open.map((c) => d.channelFacts.find((f) => f.channelId === c.id)?.ageDays ?? null);
    if (ages.every((a) => a !== null && a < days)) return { text: "A new channel: no forwards yet.", tone: "neutral" };
    // How old it is can't be told: it may just be new.
    if (ages.some((a) => a === null)) return { text: `No forwards in the last ${days} days.`, tone: "neutral" };
    return { text: `No forwards in the last ${days} days: ${satsCompact(local)} sat of yours sit idle here.`, tone: "warn" };
  }
  const brought = t.broughtInSats > 0 ? ` It also brought in forwards that earned ${sats(t.broughtInSats)} sat elsewhere.` : "";
  const refills = t.refillFeeSats > 0 ? ` Refills cost ${sats(t.refillFeeSats)} sat.` : "";
  if (t.earnedSats === 0 && t.broughtInSats === 0) return { text: `${t.forwards} forward${t.forwards === 1 ? "" : "s"} in the last ${days} days, for under 1 sat in fees.${refills}`, tone: "neutral" };
  return { text: `Earned ${sats(t.earnedSats)} sat in the last ${days} days.${brought}${refills}`, tone: t.earnedSats + t.broughtInSats > t.refillFeeSats ? "good" : "neutral" };
}

/** Who a channel's fee was set by, in a history line. */
const VIA: Record<"autopilot" | "lease" | "manual", string> = {
  autopilot: "autopilot",
  lease: "lease promise",
  manual: "by hand",
};

/** One line of what happened on this node's channels. */
export function eventText(e: NodeEvent): { title: string; detail: string | null } {
  if (e.kind === "fee") {
    const from = e.fromPpm === null ? "" : `${e.fromPpm} → `;
    return { title: `Fee ${from}${e.toPpm} ppm (${VIA[e.via]})`, detail: e.why ? e.why.split(" — ")[0] : null };
  }
  const paid = e.feeSats === null ? "" : ` for ${sats(e.feeSats)} sat`;
  return {
    title: e.direction === "in" ? `Refilled with ${satsCompact(e.amountSats)} sat${paid} (${VIA[e.via]})` : `Gave ${satsCompact(e.amountSats)} sat to refill another channel${paid} (${VIA[e.via]})`,
    detail: null,
  };
}

/** One closed channel with this node. */
export function closedText(c: NodeClosedChannel): string {
  const how = { cooperative: "closed together", you_forced: "force-closed by you", they_forced: "force-closed by them", breach: "breach close", other: "closed" }[c.how];
  const when = c.closedDaysAgo === null ? "" : c.closedDaysAgo === 0 ? ", recently" : `, ${c.closedDaysAgo} days ago`;
  return `${satsCompact(c.capacitySats)} sat, ${how}${when}`;
}

/** Where a node runs, from its public record (null: nothing to say). */
export function placeText(r: PublicNodeRecord): string | null {
  if (r.city && r.country) return `${r.city}, ${r.country}`;
  return r.country;
}

/** "April 2018 (8.6 years)". */
export function firstSeenText(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const month = new Date(at).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const age = ageText((nowMs - at) / 86_400_000);
  return age ? `${month} (${age})` : month;
}

export interface ChannelNote {
  text: string;
  tone: "lease" | "warn" | "plain";
  title?: string;
}

/** What is worth saying about a channel in its table row. */
export function channelNotes(c: ChannelView, flow: Pick<ChannelForwardStat, "forwardCount" | "inboundForwardCount"> | undefined, flowsLoaded: boolean): ChannelNote[] {
  const pendingClose = c.status === "pending_close";
  const pendingOpen = c.status === "pending_open";
  const notes: ChannelNote[] = [];
  if (pendingClose) notes.push({ text: c.timelockBlocks ? `pending close · ~${c.timelockBlocks} blks` : "pending close", tone: "warn", title: "Waiting for the transaction to confirm" });
  if (pendingOpen) notes.push({ text: "pending open · confirming", tone: "plain", title: "Waiting for the transaction to confirm" });
  if (c.private && !pendingClose && !pendingOpen) notes.push({ text: "private", tone: "plain" });
  const lease = leaseTag(c.lease);
  if (lease) notes.push({ text: lease, tone: "lease", title: "Closing it before the lease ends breaks the lease — the close dialog asks first" });
  const away = !pendingClose && !pendingOpen ? offlineLabel(c.offline) : null;
  if (away) notes.push({ text: away, tone: c.offline?.long ? "warn" : "plain", title: "How long the peer has been away (short outages are common over Tor)" });
  if (c.status === "open" && c.active && flowsLoaded && !(flow && flow.forwardCount + flow.inboundForwardCount > 0)) {
    // Younger than the window: it hasn't had the time.
    notes.push({ text: c.ageDays !== null && c.ageDays < 30 ? "new, no forwards yet" : "no forwards in 30 d", tone: "plain" });
  }
  return notes;
}

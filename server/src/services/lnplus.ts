/**
 * lightningnetwork.plus (LN+) client — the PUBLIC, key-free half of the API.
 *
 *   GET /api/2/get_node/pubkey=<pk>   node profile incl. the LN+ reputation
 *   GET /api/2/get_pool_nodes         Liquidity Pool participants
 *   GET /api/2/get_swaps/             Liquidity Swaps (open + running)
 *
 * Why this matters to us: our peer suggestions score the network GRAPH
 * (connectivity, depth, activity, fees). LN+ adds the one thing a graph can
 * never show — whether real operators have dealt with that node and would do it
 * again. That is a social signal, and it is exactly what a "should I lock
 * capital into this peer for months" decision is missing.
 *
 * Everything here is read-only and needs no credentials. The authenticated half
 * (joining swaps, pool credit transactions) is deliberately NOT in this file —
 * it carries a 100-calls-per-24h budget and real obligations, so it lands in a
 * later, separate step.
 */

const BASE = "https://lightningnetwork.plus/api/2";
const UA = "LightningMate";

/** LN+ answers "this node has no LN+ profile" with 422, not 404. */
export class LnPlusNotFound extends Error {
  constructor(pubkey: string) {
    super(`no LN+ profile for ${pubkey.slice(0, 12)}…`);
    this.name = "LnPlusNotFound";
  }
}

async function get<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`LN+ unreachable: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new Error("LN+ rate limit reached");
  if (!res.ok) throw new Error(`LN+ HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ── Node profile ─────────────────────────────────────────────────────────────

export interface LnPlusBadge {
  name: string;
  description: string;
}

export interface LnPlusNode {
  pubkey: string;
  alias: string;
  /** 0–10 LN+ rank; the headline reputation number. */
  rank: number;
  /** Metal name for the rank ("Mercury", "Platinum", …). */
  rankName: string;
  /** 10+ ratings AND 90%+ positive — the bar most swaps gate on. */
  prime: boolean;
  pro: boolean;
  /** The operator signed a message with the node — it is really theirs. */
  verified: boolean;
  positiveRatings: number;
  negativeRatings: number;
  positiveGiven: number;
  negativeGiven: number;
  badges: string[];
  openChannels: number;
  capacitySats: number;
  minChannelSizeSats: number;
  profileUrl: string;
}

interface RawNode {
  pubkey: string;
  alias: string | null;
  open_channels: number | null;
  capacity: number | null;
  min_channel_size: number | null;
  lnp_rank: number | null;
  lnp_rank_name: string | null;
  prime: boolean | null;
  pro: boolean | null;
  lnp_verified_user: boolean | null;
  lnp_positive_ratings_received: number | null;
  lnp_negative_ratings_received: number | null;
  lnp_positive_ratings_given: number | null;
  lnp_negative_ratings_given: number | null;
  lnp_badges: LnPlusBadge[] | null;
  profile_urls: Record<string, string> | null;
}

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

function mapNode(r: RawNode): LnPlusNode {
  return {
    pubkey: r.pubkey,
    alias: r.alias?.trim() || "",
    rank: num(r.lnp_rank),
    rankName: r.lnp_rank_name ?? "",
    prime: r.prime === true,
    pro: r.pro === true,
    verified: r.lnp_verified_user === true,
    positiveRatings: num(r.lnp_positive_ratings_received),
    negativeRatings: num(r.lnp_negative_ratings_received),
    positiveGiven: num(r.lnp_positive_ratings_given),
    negativeGiven: num(r.lnp_negative_ratings_given),
    badges: (r.lnp_badges ?? []).map((b) => b.name),
    openChannels: num(r.open_channels),
    capacitySats: num(r.capacity),
    minChannelSizeSats: num(r.min_channel_size),
    profileUrl: r.profile_urls?.["LN+"] ?? `https://lightningnetwork.plus/nodes/${r.pubkey}`,
  };
}

/** One node's LN+ profile. Throws LnPlusNotFound when it has none. */
export async function getNode(pubkey: string): Promise<LnPlusNode> {
  let raw: RawNode;
  try {
    raw = await get<RawNode>(`/get_node/pubkey=${encodeURIComponent(pubkey)}`);
  } catch (e) {
    // 422 = "not found" in LN+ terms: a normal negative answer, not a failure.
    if (e instanceof Error && /HTTP 422/.test(e.message)) throw new LnPlusNotFound(pubkey);
    throw e;
  }
  if (!raw?.pubkey) throw new LnPlusNotFound(pubkey);
  return mapNode(raw);
}

// ── Liquidity Pool ───────────────────────────────────────────────────────────

export interface LnPlusPoolNode {
  pubkey: string;
  alias: string;
  /** Credits this node can spend — how much inbound it can ask for. */
  creditsBalanceSats: number;
  minChannelSizeSats: number;
  capacitySats: number;
  openChannels: number;
  /** "Clearnet / Tor", "Tor", "Clearnet". */
  connection: string;
  clearnetAddress: string;
  torAddress: string;
  rank: number;
  rankName: string;
  positiveRatings: number;
  negativeRatings: number;
  profileUrl: string;
  /** True when the node is reachable over Tor (our own node is Tor-only). */
  reachableOverTor: boolean;
}

interface RawPoolNode {
  pubkey: string;
  alias: string | null;
  web_url: string | null;
  credits_balance_sats: number | null;
  min_channel_size_sats: number | null;
  capacity_sats: number | null;
  open_channels: number | null;
  connection: string | null;
  clearnet_address: string | null;
  tor_address: string | null;
  lnp_rank: number | null;
  lnp_rank_name: string | null;
  lnp_positive_ratings_received: number | null;
  lnp_negative_ratings_received: number | null;
}

export interface PoolQuery {
  /**
   * LN+ `min_size` filters on the node's CREDITS BALANCE, not on channel size
   * (verified against the live API: min_size=50000000 returns exactly the nodes
   * whose credits_balance_sats is at least that). Credits are what a pool node
   * can spend to have a channel opened to it, so this is "who can afford size".
   */
  minCreditsSats?: number;
  limit?: number;
  search?: string;
}

/** Liquidity Pool participants (public, no key). Returns at most 50 per page,
 *  ordered by credits balance descending. */
export async function getPoolNodes(q: PoolQuery = {}): Promise<LnPlusPoolNode[]> {
  const params = new URLSearchParams();
  if (q.minCreditsSats) params.set("min_size", String(q.minCreditsSats));
  if (q.limit) params.set("limit", String(q.limit));
  if (q.search) params.set("search", q.search);
  const qs = params.toString();
  const raw = await get<RawPoolNode[]>(`/get_pool_nodes${qs ? `?${qs}` : ""}`);
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    pubkey: r.pubkey,
    alias: r.alias?.trim() || `${r.pubkey.slice(0, 12)}…`,
    creditsBalanceSats: num(r.credits_balance_sats),
    minChannelSizeSats: num(r.min_channel_size_sats),
    capacitySats: num(r.capacity_sats),
    openChannels: num(r.open_channels),
    connection: r.connection ?? "",
    clearnetAddress: r.clearnet_address ?? "",
    torAddress: r.tor_address ?? "",
    rank: num(r.lnp_rank),
    rankName: r.lnp_rank_name ?? "",
    positiveRatings: num(r.lnp_positive_ratings_received),
    negativeRatings: num(r.lnp_negative_ratings_received),
    profileUrl: r.web_url ?? `https://lightningnetwork.plus/nodes/${r.pubkey}`,
    reachableOverTor: !!r.tor_address,
  }));
}

// ── Liquidity Swaps ──────────────────────────────────────────────────────────

export interface LnPlusSwapParticipant {
  identifier: string;
  pubkey: string;
  alias: string;
  status: string;
  cancelled: boolean;
}

export interface LnPlusSwap {
  id: number;
  url: string;
  status: string;
  statusText: string;
  capacitySats: number;
  durationMonths: number;
  maxParticipants: number;
  appliedParticipants: number;
  openSeats: number;
  /** Eligibility gates the swap creator set. */
  requiresPrime: boolean;
  requiresPro: boolean;
  minCapacitySats: number | null;
  minChannelsCount: number | null;
  clearnetAllowed: boolean;
  torAllowed: boolean;
  isPrivate: boolean;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  participants: LnPlusSwapParticipant[];
}

interface RawSwap {
  id: number;
  web_url: string | null;
  status: string | null;
  humanized_status: string | null;
  capacity_sats: number | null;
  duration_months: number | null;
  participant_max_count: number | null;
  participant_applied_count: number | null;
  participant_waiting_for_count: number | null;
  participant_min_capacity_sats: number | null;
  participant_min_channels_count: number | null;
  clearnet_connection_allowed: boolean | null;
  tor_connection_allowed: boolean | null;
  prime: boolean | null;
  pro: boolean | null;
  private: boolean | null;
  created_at: string;
  starts: string | null;
  ends: string | null;
  participants:
    | {
        participant_identifier: string | null;
        pubkey: string;
        alias: string | null;
        application_status: string | null;
        cancelled: boolean | null;
      }[]
    | null;
}

export interface SwapQuery {
  /** "pending" = still taking applicants; that is the joinable set. */
  status?: "pending" | "opening" | "completed";
  limit?: number;
}

/** Liquidity Swaps (public, no key). Max 50 per call per the LN+ docs. */
export async function getSwaps(q: SwapQuery = {}): Promise<LnPlusSwap[]> {
  const params = new URLSearchParams();
  if (q.status) params.set("status", q.status);
  params.set("limit", String(Math.min(50, Math.max(1, q.limit ?? 50))));
  const raw = await get<RawSwap[]>(`/get_swaps/?${params.toString()}`);
  return (Array.isArray(raw) ? raw : []).map((s) => {
    const max = num(s.participant_max_count);
    const applied = num(s.participant_applied_count);
    return {
      id: s.id,
      url: s.web_url ?? `https://lightningnetwork.plus/swaps/${s.id}`,
      status: s.status ?? "",
      statusText: s.humanized_status ?? s.status ?? "",
      capacitySats: num(s.capacity_sats),
      durationMonths: num(s.duration_months),
      maxParticipants: max,
      appliedParticipants: applied,
      openSeats: s.participant_waiting_for_count != null
        ? num(s.participant_waiting_for_count)
        : Math.max(0, max - applied),
      requiresPrime: s.prime === true,
      requiresPro: s.pro === true,
      minCapacitySats: s.participant_min_capacity_sats ?? null,
      minChannelsCount: s.participant_min_channels_count ?? null,
      clearnetAllowed: s.clearnet_connection_allowed !== false,
      torAllowed: s.tor_connection_allowed !== false,
      isPrivate: s.private === true,
      createdAt: s.created_at,
      startsAt: s.starts,
      endsAt: s.ends,
      participants: (s.participants ?? []).map((p) => ({
        identifier: p.participant_identifier ?? "",
        pubkey: p.pubkey,
        alias: p.alias?.trim() || `${p.pubkey.slice(0, 12)}…`,
        status: p.application_status ?? "",
        cancelled: p.cancelled === true,
      })),
    };
  });
}

// ── Eligibility (local, no API call) ─────────────────────────────────────────

export interface NodeFacts {
  capacitySats: number;
  channelCount: number;
  hasClearnet: boolean;
  hasTor: boolean;
  prime: boolean;
  pro: boolean;
}

export interface Eligibility {
  eligible: boolean;
  /** Why not — plain reasons we can show next to the swap. */
  blockers: string[];
}

/**
 * Can THIS node join that swap? Checked locally against the gates LN+ publishes
 * on the swap, so the UI never invites the user into a swap that would reject
 * them (and never spends an API call finding out).
 */
export function checkSwapEligibility(swap: LnPlusSwap, me: NodeFacts): Eligibility {
  const blockers: string[] = [];
  if (swap.openSeats <= 0) blockers.push("no open seats left");
  if (swap.status !== "pending") blockers.push("no longer taking applicants");
  if (swap.requiresPrime && !me.prime) blockers.push("requires LN+ Prime (10+ ratings, 90%+ positive)");
  if (swap.requiresPro && !me.pro) blockers.push("requires an LN+ Pro membership");
  if (swap.minCapacitySats != null && me.capacitySats < swap.minCapacitySats)
    blockers.push(`needs ${(swap.minCapacitySats / 1e6).toFixed(1)}M sat total capacity`);
  if (swap.minChannelsCount != null && me.channelCount < swap.minChannelsCount)
    blockers.push(`needs ${swap.minChannelsCount} open channels`);
  // A Tor-only node can only take part where Tor is allowed.
  if (!me.hasClearnet && !swap.torAllowed) blockers.push("clearnet-only swap, your node is Tor-only");
  if (!me.hasTor && !swap.clearnetAllowed) blockers.push("Tor-only swap, your node has no onion address");
  return { eligible: blockers.length === 0, blockers };
}

import type { FetchMock, RecordedRequest } from "./fetchMock.js";
import { hang } from "./fetchMock.js";
import { ambossSpaceSchema, checkDocument, checkVariables, magmaSchema, parseOperation } from "./graphqlSchema.js";
import type { AfterHook } from "./tmp.js";

export const AMBOSS_SPACE = "https://api.amboss.space/graphql";
const MAGMA = "https://magma.amboss.tech/graphql";

/**
 * Amboss's PUBLIC market data, faked: the legacy offer book (getOffers, with
 * seller scores, caps and buyer conditions), a node's Magma record (getNode),
 * the public Magma offer list (filled orders, listing dates, Amboss fees) and
 * the dollar rate (liquidity_per_usd). Every request is checked against the
 * saved schema of its endpoint, like the Magma fake.
 *
 * Like the live endpoint, the public offer list ignores its `page` argument
 * by default: every page is the whole list (`paging = "pages"` honours it).
 * Before, the fake sliced pages — so no test could see the reader count each
 * offer twice once the list grew past one page.
 *
 *   const market = new FakeMarket(http, t);
 *   market.addOffer({ sellerScore: 3, totalSats: 2_000_000, filledOrders: 0, monthsListed: 6 });
 *   market.ownScore = 5.22;
 */
export interface MarketOfferSpec {
  id?: string;
  sellerPubkey?: string;
  sellerScore?: number;
  totalSats?: number;
  minSats?: number;
  maxSats?: number;
  lockedSats?: number;
  feeRatePpm?: number;
  baseFeeSats?: number;
  minBlockLength?: number;
  feeRateCap?: number | null;
  baseFeeCap?: number | null;
  conditions?: { condition: string; operator: string; value: string }[];
  filledOrders?: number;
  monthsListed?: number;
  /** fees.amboss; default: the tier of the listed total (1500 ≤1M, 1000 ≤5M, 500 ≤50M, 350 above). */
  ambossFee?: number;
  status?: string;
  /** The channel's asset (default BASE_ASSET, bitcoin). A Taproot-asset offer
   *  (e.g. USDT) has no satoshi total in the public list and is not in the
   *  legacy book — as Amboss lists the two live ones (2026-10-21). */
  asset?: "BASE_ASSET" | "TAPROOT_ASSET";
  /** Only in the legacy book, or only in the public Magma list. */
  only?: "legacy" | "public";
}

/** An offer as the fake holds it: every field set. */
export type MarketOffer = Required<Omit<MarketOfferSpec, "only">> & { only?: "legacy" | "public" };

let nextId = 1;

/** Amboss's fee grid as observed (2026-10): by listed total. */
export const ambossFeeFor = (totalSats: number): number =>
  totalSats <= 1_000_000 ? 1500 : totalSats <= 5_000_000 ? 1000 : totalSats <= 50_000_000 ? 500 : 350;

export class FakeMarket {
  readonly offers: MarketOffer[] = [];
  readonly schemaErrors: string[] = [];
  /** The node's own record (getNode). null: Amboss has none. */
  ownScore: number | null = null;
  ownConfirmedSells: number | null = 0;
  /** liquidity_per_usd: inbound sats per $ and the $ value of those sats. */
  inboundSatsPerUsd = 415_774;
  btcSatsPerUsd = 1_225;
  /** "throw": the public endpoints answer HTTP 502. "hang": they never
   *  answer (the caller's deadline fires). */
  behaviour: "ok" | "throw" | "hang" = "ok";
  /** How the public offer list answers its `page` argument. "whole-list":
   *  as magma.amboss.tech does (checked 2026-10-21) — every page is the whole
   *  list, `total` its length. "pages": offset/limit honoured. */
  paging: "whole-list" | "pages" = "whole-list";
  /** The `page` argument of every public-list request, in order. */
  readonly pagesAsked: { limit: number; offset: number }[] = [];
  /** Requests that reached the public endpoints (answered or not). */
  requests = 0;
  readonly calls: string[] = [];

  constructor(http: FetchMock, t?: AfterHook) {
    http.onGraphql(AMBOSS_SPACE, /getOffers|NodeMarket/, (variables, req) => this.space(variables, req));
    http.onGraphql(MAGMA, /PublicOffers|liquidity_per_usd/, (variables, req) => this.magma(variables, req));
    t?.after(() => {
      if (this.schemaErrors.length) throw new Error(`public market requests that don't match the schema:\n  ${this.schemaErrors.join("\n  ")}`);
    });
  }

  addOffer(o: MarketOfferSpec = {}): MarketOffer {
    const total = o.totalSats ?? 2_000_000;
    const offer: MarketOffer = {
      id: o.id ?? `mkt-offer-${nextId++}`,
      sellerPubkey: o.sellerPubkey ?? "03" + (nextId % 256).toString(16).padStart(2, "0").repeat(32),
      sellerScore: o.sellerScore ?? 0,
      totalSats: total,
      minSats: o.minSats ?? 1_000_000,
      maxSats: o.maxSats ?? total,
      lockedSats: o.lockedSats ?? 0,
      feeRatePpm: o.feeRatePpm ?? 3000,
      baseFeeSats: o.baseFeeSats ?? 568,
      minBlockLength: o.minBlockLength ?? 4320,
      feeRateCap: o.feeRateCap ?? 2200,
      baseFeeCap: o.baseFeeCap ?? 1,
      conditions: o.conditions ?? [],
      filledOrders: o.filledOrders ?? 0,
      monthsListed: o.monthsListed ?? 6,
      ambossFee: o.ambossFee ?? ambossFeeFor(total),
      status: o.status ?? "ENABLED",
      asset: o.asset ?? "BASE_ASSET",
      only: o.only,
    };
    this.offers.push(offer);
    return offer;
  }

  private check(schema: "space" | "magma", req: RecordedRequest, variables: Record<string, unknown>): string | null {
    const query = req.graphql?.query ?? "";
    const s = schema === "space" ? ambossSpaceSchema() : magmaSchema();
    const errors = [...checkDocument(s, query), ...checkVariables(s, query, variables)];
    if (errors.length) {
      this.schemaErrors.push(...errors.map((e) => `${parseOperation(query).name ?? "anonymous"}: ${e}`));
      return errors.join("; ");
    }
    return null;
  }

  private all(): MarketOffer[] {
    return this.offers;
  }

  private space(variables: Record<string, unknown>, req: RecordedRequest): Response | Record<string, unknown> | Promise<Response> {
    this.requests++;
    const bad = this.check("space", req, variables);
    if (bad) return Response.json({ errors: [{ message: bad, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, { status: 400 });
    if (this.behaviour === "throw") return new Response("upstream error", { status: 502 });
    if (this.behaviour === "hang") return hang(req);
    const query = req.graphql?.query ?? "";
    if (/NodeMarket/.test(query)) {
      this.calls.push("NodeMarket");
      return {
        data: {
          getNode: {
            amboss: {
              market: {
                seller_score: this.ownScore === null ? "0" : String(this.ownScore),
                stats: { sell: { confirmed_orders: this.ownConfirmedSells ?? 0 } },
              },
            },
          },
        },
      };
    }
    this.calls.push("getOffers");
    return {
      data: {
        getOffers: {
          list: this.all()
            .filter((o) => o.only !== "public" && o.asset === "BASE_ASSET")
            .map((o) => ({
              id: o.id,
              account: o.sellerPubkey,
              min_size: String(o.minSats),
              max_size: String(o.maxSats),
              base_fee: o.baseFeeSats,
              fee_rate: o.feeRatePpm,
              seller_score: String(o.sellerScore),
              status: o.status,
              side: "SELL",
              total_size: String(o.totalSats),
              min_block_length: o.minBlockLength,
              fee_rate_cap: o.feeRateCap,
              base_fee_cap: o.baseFeeCap,
              conditions: o.conditions,
              orders: { locked_size: String(o.lockedSats) },
            })),
        },
      },
    };
  }

  private magma(variables: Record<string, unknown>, req: RecordedRequest): Response | Record<string, unknown> | Promise<Response> {
    this.requests++;
    const bad = this.check("magma", req, variables);
    if (bad) return Response.json({ errors: [{ message: bad, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, { status: 400 });
    if (this.behaviour === "throw") return new Response("upstream error", { status: 502 });
    if (this.behaviour === "hang") return hang(req);
    const query = req.graphql?.query ?? "";
    if (/liquidity_per_usd/.test(query)) {
      this.calls.push("liquidity_per_usd");
      return {
        data: {
          market: {
            liquidity: {
              liquidity_per_usd: { sats: String(this.inboundSatsPerUsd), usd: String(this.inboundSatsPerUsd / this.btcSatsPerUsd) },
            },
          },
        },
      };
    }
    this.calls.push("PublicOffers");
    const page = (variables.page ?? { limit: 50, offset: 0 }) as { limit: number; offset: number };
    this.pagesAsked.push(page);
    const list = this.all().filter((o) => o.only !== "legacy");
    const answered = this.paging === "pages" ? list.slice(page.offset, page.offset + page.limit) : list;
    return {
      data: {
        market: {
          offer: {
            offers: {
              list: answered.map((o) => ({
                id: o.id,
                status: o.status,
                created_at: new Date(Date.now() - o.monthsListed * 30 * 86_400_000).toISOString(),
                filled_orders: o.filledOrders,
                node: { pubkey: o.sellerPubkey },
                asset: { type: o.asset },
                total_amount: { satoshi: o.asset === "BASE_ASSET" ? { sats: String(o.totalSats) } : null },
                fees: { amboss: { sats: String(o.ambossFee) } },
              })),
              total: list.length,
            },
          },
        },
      },
    };
  }
}

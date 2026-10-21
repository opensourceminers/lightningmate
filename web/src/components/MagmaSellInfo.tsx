import type { Eligibility, SellDiagnostics } from "../types";
import { CHECK_MARK, SELLER_SCORE_COPY, VERDICT } from "../magmaView";

/**
 * The honest part of Market → Sell: can this node sell at all (live numbers
 * from Amboss's public book), why it isn't selling (the diagnostics checklist,
 * answered from the live state), and how Amboss picks sellers. Presentational
 * only — the data comes in as props.
 */

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** D8: the eligibility verdict, with the live numbers behind it. */
export function EligibilityCard({
  e,
  busy,
  onRefresh,
}: {
  e: Eligibility | null;
  busy?: boolean;
  onRefresh?: () => void;
}) {
  if (!e) {
    return (
      <div className="elig-card">
        <div className="elig-head">
          <span className="elig-title">Can this node sell on Magma?</span>
          <span className="muted">{busy ? "checking Amboss's public offer book…" : "not checked yet"}</span>
        </div>
      </div>
    );
  }
  const v = VERDICT[e.verdict];
  return (
    <div className={`elig-card tone-${v.tone}`}>
      <div className="elig-head">
        <span className="elig-title">Can this node sell on Magma?</span>
        <span className={`elig-verdict tone-${v.tone}`}>{v.label}</span>
        {onRefresh ? (
          <button className="linklike" disabled={busy} onClick={onRefresh}>
            {busy ? "checking…" : "check again"}
          </button>
        ) : null}
      </div>
      <ul className="elig-reasons">
        {e.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {e.expectedSalesPerYear !== null ? (
        <div className="elig-expect">
          Expect about <b>{e.expectedSalesPerYear < 0.1 ? "no" : e.expectedSalesPerYear.toFixed(1)}</b> sale
          {e.expectedSalesPerYear >= 0.95 && e.expectedSalesPerYear < 1.05 ? "" : "s"} a year with an offer like yours.
        </div>
      ) : null}
      <div className="muted elig-note">
        Indicative: computed from Amboss's public offer book{e.bookFetchedAt ? ` (read ${new Date(e.bookFetchedAt).toLocaleString()})` : ""} —
        Amboss's matching itself isn't public. {SELLER_SCORE_COPY}
      </div>
    </div>
  );
}

/** "Why don't I sell?" — every check of the diagnosis, from the live state. */
export function SellDiagnosticsCard({
  d,
  onFix,
}: {
  d: SellDiagnostics | null;
  onFix?: (tab: string, sub?: string) => void;
}) {
  if (!d) return null;
  const problems = d.checks.filter((c) => c.status === "problem").length;
  return (
    <details className="diag-card" open={problems > 0}>
      <summary>
        <span className="diag-title">Selling diagnostics</span>{" "}
        <span className={problems ? "diag-count bad" : "diag-count ok"}>
          {problems ? `${problems} problem${problems === 1 ? "" : "s"}` : "no problem found"}
        </span>
      </summary>
      <ul className="diag-list">
        {d.checks.map((c) => (
          <li key={c.id} className={`diag-row s-${c.status}`}>
            <span className="diag-mark" aria-label={c.status}>
              {CHECK_MARK[c.status]}
            </span>
            <span className="diag-label">{c.label}</span>
            <span className="diag-detail">{c.detail}</span>
            {c.fix && c.status === "problem" && onFix ? (
              <button className="linklike" onClick={() => onFix(c.fix!.tab, c.fix!.sub)}>
                {c.fix.label}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {d.offers.map((o) => (
        <OfferTermsCompare key={o.offerId} o={o} />
      ))}
      {d.orders.recent.length ? (
        <>
          <div className="diag-sub">Recent orders</div>
          <table className="table compact">
            <tbody>
              {d.orders.recent.map((o) => (
                <tr key={o.orderId}>
                  <td className="muted">{new Date(o.at).toLocaleString()}</td>
                  <td className="num">{fmt(o.sizeSats)} sat</td>
                  <td>{o.action}</td>
                  <td className="muted">{o.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </details>
  );
}

const OWNER_LABEL: Record<SellDiagnostics["offers"][number]["owner"], string> = {
  autopilot: "terms set by the autopilot",
  you: "terms set by you",
  nobody: "not managed (Liquidity provision off)",
};

/** One offer as Amboss has it, next to what the engine would list — each
 *  term that differs marked. */
export function OfferTermsCompare({ o }: { o: SellDiagnostics["offers"][number] }) {
  const a = o.amboss;
  const t = o.target;
  const promise = (rate: number | null, base: number | null) => (rate && rate > 0 ? `≤ ${fmt(rate)} ppm + ${base ?? 0} sat` : "none");
  const rows: [string, string, string | null][] = [
    ["Price", `${fmt(a.feeRatePpm)} ppm + ${fmt(a.baseFeeSats)} sat`, t ? `${fmt(t.feeRatePpm)} ppm + ${fmt(t.baseFeeSats)} sat` : null],
    ["Window", `${fmt(a.minSizeSats)}–${fmt(a.maxSizeSats)} sat`, t ? `${fmt(t.minSizeSats)}–${fmt(t.maxSizeSats)} sat` : null],
    ["Lease", `${fmt(a.minBlockLength)} blocks`, t ? `${fmt(t.minBlockLength)} blocks` : null],
    ["Fee promise", promise(a.feeRateCapPpm, a.baseFeeCapSats), t ? promise(t.feeRateCapPpm, t.baseFeeCapSats) : null],
  ];
  return (
    <>
      <div className="diag-sub">
        Offer {o.offerId.slice(0, 8)}… · {a.status.toLowerCase()} · {OWNER_LABEL[o.owner]}
      </div>
      <table className="table compact diag-terms">
        <thead>
          <tr>
            <th></th>
            <th>On Amboss</th>
            <th>Engine's target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, have, want]) => (
            <tr key={label} className={want !== null && want !== have ? "diag-differs" : ""}>
              <td className="muted">{label}</td>
              <td>{have}</td>
              <td>{want ?? "—"}{want !== null && want !== have ? " ≠" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Market → Sell's note under the offer form: which offers promise buyers a
 * routing-fee cap, and who keeps it (D7). Only what holds: an offer created
 * or saved on that page, or listed by the autopilot, always carries the
 * promise; the autopilot writes it to the other offers it manages only with
 * auto-size on — otherwise an offer made on amboss.tech can have none (the
 * offers table shows "none"). Before: "Every offer promises buyers …", right
 * above a table that showed "none" for the live offer.
 */
export function OfferPromiseNote({
  caps,
  leaseBlocks,
  standardLeaseBlocks,
}: {
  caps: { feeRateCapPpm: number; baseFeeCapSats: number };
  /** The lease in the offer form. */
  leaseBlocks: number;
  standardLeaseBlocks: number;
}) {
  return (
    <p className="muted ap-hint">
      An offer you create or save on this page — or one the autopilot lists — promises buyers a routing fee of at most{" "}
      <b>
        {caps.feeRateCapPpm} ppm + {caps.baseFeeCapSats} sat
      </b>{" "}
      for the lease; with auto-size on, the autopilot gives the other offers it manages the same promise. Otherwise an offer
      (one made on amboss.tech, say) keeps whatever promise it has — "none" below if it has none. The fee autopilot keeps each
      sold channel within the cap its order locked (and clamps manual fee changes too).
      {leaseBlocks !== standardLeaseBlocks ? ` The standard lease is ${standardLeaseBlocks} blocks (30 days).` : ""}
    </p>
  );
}

/** The Amboss fee tiers in words: live from the public book when known. */
function tierText(tiers: { ambossFeePpm: number; upToSats: number | null }[]): string {
  return tiers
    .map((t, i) => (t.upToSats === null ? `${fmt(t.ambossFeePpm)} above` : `${fmt(t.ambossFeePpm)}${i === 0 ? " ppm" : ""} up to ${fmt(t.upToSats)} sat`))
    .join(", ");
}

/**
 * How Amboss picks sellers — what its documentation says, and what its public
 * market data showed when checked (October 2026), and what that means for a
 * small node. Live numbers where there are any; everything else labelled as
 * what it is: documented, observed (dated), or inferred.
 */
export function HowAmbossPicks({
  usdOrderSat,
  usdAtOwnPriceSat,
  feeTiers,
}: {
  usdOrderSat?: number | null;
  usdAtOwnPriceSat?: number | null;
  /** The live book's Amboss fee tiers (eligibility check); none: the dated ones. */
  feeTiers?: { ambossFeePpm: number; upToSats: number | null }[] | null;
}) {
  return (
    <details className="how-card">
      <summary>How Amboss picks sellers</summary>
      <ul className="how-list">
        <li>
          <b>Amboss assigns most orders itself.</b> Its buy button and its LSP endpoints pick the seller — "ranked by historical
          performance, fees, and uptime" (Amboss docs). On the public order history (October 2026), orders went to sellers with a
          reliability record; cheap offers without one were not picked. Amboss's older docs also named the seller's position in
          the network — that grows only with well-connected public channels, not with any offer setting.
        </li>
        <li>
          <b>"Fast Fulfillment" matches only Amboss's own Rails cluster</b> (Amboss docs), and it was the buy page's default when
          checked in October 2026. Amboss's LSP endpoints (what wallets buy through) each answered with a single seller then —
          nodes sharing Amboss's own hosting, so inferred to be Amboss's (an observation of October 2026, not a documented rule).
          Only buyers who switch Fast Fulfillment off, or pick an offer by hand, reach other sellers — and the hand-picked list on
          amboss.space sorted offers by seller score first. (Amboss sells a hosted way into its Rails cluster; it hands Amboss
          control of channels and fees, which would fight LightningMate's own autopilot.)
        </li>
        <li>
          <b>Buy-button orders are sized in dollars</b> ($5 minimum, $10 by default)
          {usdOrderSat ? (
            <>
              : the smallest is about <b>{fmt(usdOrderSat)} sat</b> of channel at today's rate (live from Amboss)
              {usdAtOwnPriceSat ? <>, about {fmt(usdAtOwnPriceSat)} sat at your offer's price</> : null}
            </>
          ) : null}
          . An offer whose largest channel is below that can only take fixed-size orders (e.g. exactly 1M).
        </li>
        <li>
          <b>Amboss adds its own fee, paid by the buyer</b>, by the order's size (
          {feeTiers && feeTiers.length ? (
            <>live from Amboss's public offer book: {tierText(feeTiers)}</>
          ) : (
            <>on fills of October 2026: 1,500 ppm up to 1M, 1,000 up to 5M, 500 up to 50M, 350 above</>
          )}
          ). Small orders cost buyers more on top of your price.
        </li>
        <li>
          <b>The seller score.</b> {SELLER_SCORE_COPY} Without completed sales it stays low (no seller without a sale scored above
          ~20 in October 2026) — neither price, size, fee caps nor a subscription moved it.
        </li>
        <li>
          <b>Amboss's paid plans</b> advertise "Magma liquidity priority". On the public data (October 2026), sellers with a
          subscription did not sell measurably more once seller score and listed size are accounted for — so LightningMate
          doesn't present a plan as a fix.
        </li>
        <li>
          <b>Tor-only nodes can sell</b> — Tor is not what blocks matching: in October 2026, Tor-only sellers with a track record
          had sold, and Amboss sets no network requirement for sellers.
        </li>
        <li>
          <b>So for a small node, price and size are not the lever.</b> With Liquidity provision on, LightningMate fulfils orders
          fast and safely and keeps every offer within what it can fund; with auto-size on, it also gives the offers it manages
          the standard 30-day lease, a routing-fee promise (which the fee autopilot keeps for every channel sold) and a size
          window it can fund. Whether Amboss sends an order is Amboss's choice. The 1% service fee applies only to completed
          sales.
        </li>
        <li>
          <b>Other uses of the same capital:</b> a routing channel to a well-connected peer usually earns more on a small node; LN+
          swaps (joined by you, never automatically) or LSP mode (selling directly to wallets you know) are alternatives.
        </li>
      </ul>
    </details>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import type { MagmaSellOfferState, MagmaV2Report, MyOffer, PricePoint } from "../types";
import { sats, satsCompact } from "../format";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";

const DEFAULTS = {
  totalSizeSats: 5_000_000,
  minSizeSats: 1_000_000,
  maxSizeSats: 5_000_000,
  feeRatePpm: 500,
  baseFeeSats: 1000,
  minBlockLength: 4032,
};
type Draft = typeof DEFAULTS;

const FIELDS: { key: keyof Draft; label: string; hint: string }[] = [
  { key: "totalSizeSats", label: "Total (sat)", hint: "total liquidity you'll sell across orders" },
  { key: "minSizeSats", label: "Min channel (sat)", hint: "smallest channel a buyer can order" },
  { key: "maxSizeSats", label: "Max channel (sat)", hint: "largest channel a buyer can order" },
  { key: "feeRatePpm", label: "Fee rate (ppm)", hint: "lease fee per sat of channel size" },
  { key: "baseFeeSats", label: "Base fee (sat)", hint: "flat fee added per order" },
  { key: "minBlockLength", label: "Min lease (blocks)", hint: "how long the channel must stay open (~144 blocks/day)" },
];

const SELL_STATE_LABEL: Record<MagmaSellOfferState, string> = {
  well_priced: "well priced",
  underpriced: "underpriced",
  overpriced: "overpriced",
  below_profit_floor: "below profit floor",
  do_not_list_unprofitable: "unprofitable to list",
  do_not_list_uncompetitive: "too dear to fill",
  exhausted: "exhausted — relist",
  inactive: "inactive",
};
const SELL_STATE_CLASS: Record<MagmaSellOfferState, string> = {
  well_priced: "s-good",
  underpriced: "s-explore",
  overpriced: "s-cost",
  below_profit_floor: "s-protect",
  do_not_list_unprofitable: "s-close",
  do_not_list_uncompetitive: "s-protect",
  exhausted: "s-cost",
  inactive: "s-normal",
};
const SUMMARY_LABEL: Record<MagmaV2Report["sell"]["state"], string> = {
  good_to_sell: "Good to sell",
  sell_only_above_profit_floor: "Sell above floor only",
  market_too_cheap: "Market too cheap right now",
  insufficient_capital: "Not enough idle capital",
  not_recommended_node_needs_inbound: "Your node needs inbound",
};

const asPct = (ppmPerYear: number) => `${(ppmPerYear / 10_000).toFixed(2)}%`;

export function MarketSell() {
  const ui = useUi();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [feeBps, setFeeBps] = useState(0);
  const [offers, setOffers] = useState<MyOffer[]>([]);
  const [draft, setDraft] = useState<Draft>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rec, setRec] = useState<MagmaV2Report | null>(null);
  // True when the Autopilot is auto-repricing Magma offers — manual pricing would
  // just be overwritten, so we disable the manual buttons to avoid the conflict.
  const [apManaged, setApManaged] = useState(false);

  const load = async () => {
    let conn = false;
    try {
      const s = await api.ambossStatus();
      conn = s.connected;
      setConnected(s.connected);
      setFeeBps(s.saleFeeBps ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnected(false);
      return;
    }
    if (!conn) return;
    // Best-effort — a flaky offers call (e.g. an expired key) shouldn't blank the tab.
    api.ambossMyOffers().then((r) => setOffers(r.offers)).catch(() => {});
    api.magmaRecommendations().then(setRec).catch(() => setRec(null));
    api
      .autopilotGet()
      .then((s) => setApManaged(!!(s.config?.sellEnabled && s.config?.sellAutoReprice)))
      .catch(() => setApManaged(false));
  };

  useEffect(() => {
    void load();
  }, []);

  const setNum = (k: keyof Draft, v: number) => setDraft((d) => ({ ...d, [k]: Math.max(0, Math.floor(v) || 0) }));
  const applyPrice = (p: PricePoint) =>
    setDraft((d) => ({ ...d, feeRatePpm: p.feeRatePpm, baseFeeSats: p.baseFeeSat }));

  const startEdit = (o: MyOffer) => {
    setEditingId(o.id);
    setError(null);
    setDraft({
      totalSizeSats: o.totalSizeSats,
      minSizeSats: o.minSizeSats,
      maxSizeSats: o.maxSizeSats,
      feeRatePpm: o.feeRatePpm,
      baseFeeSats: o.baseFeeSats,
      minBlockLength: o.minBlockLength,
    });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft(DEFAULTS);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!(draft.minSizeSats > 0 && draft.maxSizeSats >= draft.minSizeSats && draft.totalSizeSats >= draft.maxSizeSats)) {
      setError("Sizes must satisfy 0 < min ≤ max ≤ total.");
      return;
    }
    if (draft.baseFeeSats <= 0) {
      setError("Set a base fee above 0.");
      return;
    }
    const editing = editingId;
    const ok = await ui.confirm({
      title: editing ? "Update offer" : "Create sell offer",
      message: editing
        ? `Update your offer to channels ${satsCompact(draft.minSizeSats)}–${satsCompact(draft.maxSizeSats)} at ${draft.feeRatePpm} ppm + ${draft.baseFeeSats} sat base?`
        : `List ${satsCompact(draft.totalSizeSats)} of liquidity (channels ${satsCompact(draft.minSizeSats)}–${satsCompact(draft.maxSizeSats)} at ${draft.feeRatePpm} ppm)? When someone buys, you must open a channel to them in time or your seller score drops.`,
      confirmLabel: editing ? "Save changes" : "Create offer",
    });
    if (!ok) return;
    setBusy(true);
    try {
      if (editing) await api.ambossUpdateOffer(editing, draft);
      else await api.ambossCreateOffer(draft);
      ui.toast(editing ? "Offer updated." : "Offer created.", "success");
      setEditingId(null);
      setDraft(DEFAULTS);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string) => {
    setTogglingId(id);
    try {
      await api.ambossToggleOffer(id);
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setTogglingId(null);
    }
  };

  if (connected === false) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Sell liquidity</h2>
        </div>
        <div className="dryrun-banner">Connect your Amboss API key in <strong>Settings</strong> to create offers.</div>
      </section>
    );
  }

  const r0 = rec?.sell.recommendations[0] ?? null;
  const a = rec?.analytics;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Sell liquidity <span className="v2-badge">v2</span>
        </h2>
        {a ? (
          <span className="muted">
            {a.mySellerScore != null ? `score ${a.mySellerScore.toFixed(1)} · ` : ""}
            {a.filledOrdersAllTime} sold · {sats(a.netProfitSat)} sat net
          </span>
        ) : null}
      </div>
      <div className="dryrun-banner">
        Lease your idle liquidity where it earns more than routing. <strong>Important:</strong> when a buyer
        orders you must open a channel to them in time or your seller score drops — the Autopilot can do this
        automatically (enable <strong>Liquidity provision</strong>).
      </div>
      {feeBps > 0 ? (
        <p className="fee-note">A {feeBps / 100}% service fee on completed sales supports Lightning Mate’s development.</p>
      ) : null}

      {rec ? (
        <div className="magma-v2">
          <div className="sug-need">
            <span
              className={`sug-need-tag ${
                rec.sell.state === "good_to_sell"
                  ? "need-balanced"
                  : rec.sell.state === "not_recommended_node_needs_inbound" || rec.sell.state === "insufficient_capital" || rec.sell.state === "market_too_cheap"
                    ? "need-need_inbound"
                    : ""
              }`}
            >
              {SUMMARY_LABEL[rec.sell.state]}
            </span>
            <span className="muted">{rec.sell.reasons[0] ?? rec.nodeNeedReason}</span>
          </div>

          {rec.sell.pendingSellerOrders > 0 ? (
            <div className="magma-warn-banner">
              ⚠ {rec.sell.pendingSellerOrders} order{rec.sell.pendingSellerOrders === 1 ? "" : "s"} waiting on you — open the
              channel{rec.sell.pendingSellerOrders === 1 ? "" : "s"} in time or your seller score drops.
            </div>
          ) : null}

          <div className="magma-substats muted">
            {a?.mySellerScore != null ? (
              <>
                seller score <b>{a.mySellerScore.toFixed(1)}</b> ·{" "}
              </>
            ) : null}
            {rec.sell.projectedMonthlySat > 0 ? (
              <>
                ≈ <b>{sats(rec.sell.projectedMonthlySat)}</b> sat/mo projected ·{" "}
              </>
            ) : null}
            optimal size <b>~{satsCompact(rec.sell.optimalSizeSat)}</b> · ~{rec.sell.onchainOpenCostSat} sat to open on-chain
            {rec.sell.pricingMode === "auto" ? (
              <>
                {" "}
                · auto level <b>{Math.round(rec.sell.adaptiveLevel * 100)}%</b>
              </>
            ) : null}
          </div>

          {r0 ? (
            <>
              <div className="magma-compare">
                <div className="magma-stat">
                  <span className="magma-stat-label">Routing yield</span>
                  <span className="magma-stat-val">
                    {asPct(rec.sell.adjustedRoutingPpmPerYear)} <span className="muted">/yr on capital</span>
                  </span>
                </div>
                <span className="magma-vs">vs</span>
                <div className={`magma-stat ${r0.economics.beatsRouting ? "good" : ""}`}>
                  <span className="magma-stat-label">Magma lease</span>
                  <span className="magma-stat-val">
                    {r0.economics.leaseApy}% <span className="muted">APY</span>
                  </span>
                </div>
                <span className={`magma-verdict ${r0.economics.beatsRouting ? "win" : "lose"}`}>
                  {r0.economics.beatsRouting ? "leasing wins" : "routing wins"}
                </span>
              </div>

              <div className="magma-price-card">
                <div className="magma-price-head">
                  <span className={`feerec-state ${SELL_STATE_CLASS[r0.state]}`}>{SELL_STATE_LABEL[r0.state]}</span>
                  {r0.current ? (
                    <span>
                      current <b>{r0.current.effectiveFeePpm}</b> →{" "}
                      <b className={r0.recommended.effectiveFeePpm > r0.current.effectiveFeePpm ? "delta-up" : r0.recommended.effectiveFeePpm < r0.current.effectiveFeePpm ? "delta-down" : ""}>
                        {r0.recommended.effectiveFeePpm}
                      </b>{" "}
                      ppm effective
                    </span>
                  ) : (
                    <span>recommended <b>{r0.recommended.effectiveFeePpm} ppm</b> effective ({r0.recommended.feeRatePpm} + {r0.recommended.baseFeeSat} base)</span>
                  )}
                  {r0.market.myRank ? <span className="muted">your rank #{r0.market.myRank} of {r0.market.segmentCount}</span> : null}
                </div>
                <div className="magma-price-meta muted">
                  {r0.market.sizeBand} band · p25 {r0.market.p25} · median {r0.market.median} · p75 {r0.market.p75} ppm · floor{" "}
                  {r0.economics.profitFloorEffectivePpm}
                  {r0.market.scorePremium ? ` · ${r0.market.scorePremium > 0 ? "+" : ""}${Math.round(r0.market.scorePremium * 100)}% score ${r0.market.scorePremium > 0 ? "premium" : "discount"}` : ""}
                </div>
                {(() => {
                  const m = r0.market;
                  const cur = r0.current?.effectiveFeePpm ?? null;
                  const recv = r0.recommended.effectiveFeePpm;
                  const floor = r0.economics.profitFloorEffectivePpm;
                  const lo = Math.min(m.p10, floor, cur ?? recv) * 0.95;
                  const hi = Math.max(m.p75, recv, cur ?? 0) * 1.05;
                  const span = Math.max(1, hi - lo);
                  const pos = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
                  return (
                    <div className="magma-slider">
                      <div className="magma-slider-track" title={`market p25–p75: ${m.p25}–${m.p75} ppm · median ${m.median}`}>
                        <div
                          className="magma-slider-band"
                          style={{ left: `${pos(m.p25)}%`, width: `${Math.max(1, pos(m.p75) - pos(m.p25))}%` }}
                        />
                        <i className="magma-tick floor" style={{ left: `${pos(floor)}%` }} title={`profit floor ${floor} ppm`} />
                        <i className="magma-tick median" style={{ left: `${pos(m.median)}%` }} title={`market median ${m.median} ppm`} />
                        {cur != null ? <i className="magma-pin cur" style={{ left: `${pos(cur)}%` }} title={`your current ${cur} ppm`} /> : null}
                        <i className="magma-pin rec" style={{ left: `${pos(recv)}%` }} title={`recommended ${recv} ppm`} />
                      </div>
                      <div className="magma-slider-legend">
                        <span className="muted">cheap</span>
                        <span className="magma-leg"><i className="magma-dot band" />market</span>
                        <span className="magma-leg"><i className="magma-dot median" />median {m.median}</span>
                        {cur != null ? <span className="magma-leg"><i className="magma-dot cur" />you {cur}</span> : null}
                        <span className="magma-leg"><i className="magma-dot rec" />rec {recv}</span>
                        <span className="muted">dear</span>
                      </div>
                    </div>
                  );
                })()}
                <div className="magma-price-buttons">
                  <button className="row-btn" disabled={apManaged} title="undercut the market to fill fast" onClick={() => applyPrice(r0.pricing.fast)}>
                    Sell fast
                  </button>
                  <button className="row-btn" disabled={apManaged} onClick={() => applyPrice(r0.pricing.balanced)}>Balanced</button>
                  <button className="row-btn" disabled={apManaged} title="charge a premium (needs a strong score)" onClick={() => applyPrice(r0.pricing.premium)}>
                    Premium
                  </button>
                  <button className="row-btn ghost" disabled={apManaged} title="lowest price that still beats routing" onClick={() => applyPrice(r0.pricing.profitFloor)}>
                    Profit floor
                  </button>
                  <button className="row-btn primary" disabled={apManaged} onClick={() => applyPrice(r0.recommended)}>Apply recommended</button>
                </div>
                {apManaged ? (
                  <p className="magma-ap-note muted">
                    Autopilot is managing your Magma pricing automatically. Turn off
                    <strong> Liquidity provision</strong> in the Autopilot tab to set prices manually.
                  </p>
                ) : null}
                {r0.warnings.length ? (
                  <div className="magma-warns">
                    {r0.warnings.slice(0, 2).map((w, i) => (
                      <div key={i} className="sug-warn">⚠ {w}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="policy-controls">
        {FIELDS.map((f) => (
          <label key={f.key} className="policy-field" title={f.hint}>
            <span>{f.label}</span>
            <input type="number" min={0} value={draft[f.key]} onChange={(e) => setNum(f.key, Number(e.target.value))} />
          </label>
        ))}
        <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? (editingId ? "Saving…" : "Creating…") : editingId ? "Save changes" : "Create offer"}
        </button>
        {editingId ? (
          <button className="reset" disabled={busy} onClick={cancelEdit}>Cancel</button>
        ) : null}
      </div>
      {error ? <p className="banner error">{error}</p> : null}

      {connected === null ? (
        <p className="muted">Loading…</p>
      ) : offers.length === 0 ? (
        <EmptyState icon="🏷️">No offers yet — create one above.</EmptyState>
      ) : (
        <table className="fee-table">
          <thead>
            <tr>
              <th>Status</th>
              <th className="num">Size range</th>
              <th className="num">Total</th>
              <th className="num">Fee rate</th>
              <th className="num">Base fee</th>
              <th className="num">Lease</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => {
              const active = o.status === "ENABLED";
              return (
                <tr key={o.id} className={active ? "" : "inactive"}>
                  <td>{active ? "🟢 active" : `⚪ ${o.status.toLowerCase()}`}</td>
                  <td className="num">{satsCompact(o.minSizeSats)}–{satsCompact(o.maxSizeSats)}</td>
                  <td className="num">{satsCompact(o.totalSizeSats)}</td>
                  <td className="num">{o.feeRatePpm} ppm</td>
                  <td className="num">{o.baseFeeSats}</td>
                  <td className="num">{Math.round(o.minBlockLength / 144)}d</td>
                  <td>
                    <div className="row-actions">
                      <button className="row-btn ghost" disabled={busy} onClick={() => startEdit(o)}>edit</button>
                      <button className="row-btn ghost" disabled={togglingId !== null} onClick={() => void toggle(o.id)}>
                        {togglingId === o.id ? "…" : active ? "disable" : "enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

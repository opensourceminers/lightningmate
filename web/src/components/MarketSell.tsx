import { useEffect, useState } from "react";
import { goTo } from "../nav";
import { api } from "../api";
import type {
  AmbossKeyCheck,
  AutopilotConfig,
  Eligibility,
  MagmaSellOfferState,
  MagmaV2Report,
  MyOffer,
  OfferControl,
  OfferSyncStatus,
  PricePoint,
  SellDiagnostics,
} from "../types";
import { sats, satsCompact } from "../format";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";
import { failedOfferWrite } from "../statusNotes";
import { EligibilityCard, HowAmbossPicks, OfferPromiseNote, SellDiagnosticsCard } from "./MagmaSellInfo";
import {
  STANDARD_LEASE_BLOCKS,
  leaseToKeep,
  leaseWarning,
  offerDraftDefaults,
  offerOwner,
  offerSizeWarning,
  priceDraft,
  pricedLeaseWarning,
  sellSummary,
  type OfferDraft,
} from "../magmaView";

const FIELDS: { key: keyof OfferDraft; label: string; hint: string }[] = [
  { key: "totalSizeSats", label: "Total (sat)", hint: "total liquidity you'll sell across orders" },
  { key: "minSizeSats", label: "Min channel (sat)", hint: "smallest channel a buyer can order" },
  { key: "maxSizeSats", label: "Max channel (sat)", hint: "largest channel a buyer can order" },
  { key: "feeRatePpm", label: "Fee rate (ppm)", hint: "lease fee per sat of channel size" },
  { key: "baseFeeSats", label: "Base fee (sat)", hint: "flat fee added per order" },
  { key: "minBlockLength", label: "Min lease (blocks)", hint: "how long the channel must stay open at least (~144 blocks/day; 4320 = 30 days, the standard)" },
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
const asPct = (ppmPerYear: number) => `${(ppmPerYear / 10_000).toFixed(2)}%`;

export function MarketSell() {
  const ui = useUi();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [keyValid, setKeyValid] = useState<boolean | null | undefined>(undefined);
  const [keyCheck, setKeyCheck] = useState<AmbossKeyCheck>("unknown");
  const [sync, setSync] = useState<OfferSyncStatus | null>(null);
  const [controls, setControls] = useState<Record<string, OfferControl>>({});
  const [feeCaps, setFeeCaps] = useState<{ feeRateCapPpm: number; baseFeeCapSats: number } | null>(null);
  const [feeBps, setFeeBps] = useState(0);
  const [offers, setOffers] = useState<MyOffer[]>([]);
  const [cfg, setCfg] = useState<AutopilotConfig | null>(null);
  const [draft, setDraft] = useState<OfferDraft | null>(null);
  /** The lease the draft's price was worked out for (a price button), or null. */
  const [pricedFor, setPricedFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rec, setRec] = useState<MagmaV2Report | null>(null);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [eligBusy, setEligBusy] = useState(false);
  const [diag, setDiag] = useState<SellDiagnostics | null>(null);

  const loadEligibility = (refresh = false) => {
    setEligBusy(true);
    api
      .magmaEligibility(refresh)
      .then(setElig)
      .catch(() => setElig(null))
      .finally(() => setEligBusy(false));
  };

  const load = async () => {
    let conn = false;
    try {
      const s = await api.ambossStatus();
      conn = s.connected;
      setConnected(s.connected);
      setKeyValid(s.keyValid);
      setKeyCheck(s.keyCheck);
      setFeeBps(s.saleFeeBps ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnected(false);
      return;
    }
    // The market picture and the selling check need no key: the user deciding
    // whether to sell at all — or whose key just expired — needs them most.
    api.magmaRecommendations().then(setRec).catch(() => setRec(null));
    loadEligibility();
    api.sellDiagnostics().then(setDiag).catch(() => setDiag(null));
    api
      .autopilotGet()
      .then((s) => setCfg(s.config))
      .catch(() => setCfg(null));
    if (!conn) return;
    // Best-effort — a flaky offers call (e.g. an expired key) shouldn't blank the tab.
    api
      .ambossMyOffers()
      .then((r) => {
        setOffers(r.offers);
        setSync(r.sync);
        setControls(r.controls ?? {});
        setFeeCaps(r.feeCaps ?? null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    void load();
  }, []);

  const defaults = offerDraftDefaults(rec, cfg);
  const form = draft ?? defaults;
  const setNum = (k: keyof OfferDraft, v: number) => setDraft({ ...form, [k]: Math.max(0, Math.floor(v) || 0) });

  const ownerOf = (o: MyOffer) => offerOwner(controls[o.id], !!cfg?.sellEnabled);
  /** The autopilot sets this offer's price: manual price buttons would be
   *  overwritten — so they say so instead. */
  const autoPriced = (o: MyOffer | undefined) => !!o && !!cfg?.sellEnabled && !!cfg?.sellAutoReprice && !ownerOf(o).yours;

  /** Edit an offer — with a price button, its price applied with the lease
   *  it is for (a lease buyers use; "Apply recommended" also the engine's
   *  window: see priceDraft — saving makes the offer yours, so nothing odd
   *  is frozen in). */
  const startEdit = (o: MyOffer, price?: PricePoint, leaseBlocks?: number, full = false) => {
    setEditingId(o.id);
    setError(null);
    setPricedFor(price && leaseBlocks ? leaseBlocks : null);
    setDraft(
      price && leaseBlocks
        ? priceDraft(o, price, leaseBlocks, rec, cfg, full)
        : {
            totalSizeSats: o.totalSizeSats,
            minSizeSats: o.minSizeSats,
            maxSizeSats: o.maxSizeSats,
            feeRatePpm: o.feeRatePpm,
            baseFeeSats: o.baseFeeSats,
            minBlockLength: o.minBlockLength,
          },
    );
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
    setPricedFor(null);
    setError(null);
  };
  /** A price button: onto YOUR offer (its edit form), not a new one — with
   *  the lease the engine priced it for. Only with no offer at all does it
   *  fill the form for a new one. */
  const applyPrice = (p: PricePoint, leaseBlocks: number, full = false) => {
    const mine = offers[0];
    if (mine) startEdit(mine, p, leaseBlocks, full);
    else {
      setPricedFor(leaseBlocks);
      setDraft({ ...form, feeRatePpm: p.feeRatePpm, baseFeeSats: p.baseFeeSat, minBlockLength: leaseBlocks });
    }
  };

  const submit = async () => {
    setError(null);
    const d = form;
    if (!(d.minSizeSats > 0 && d.maxSizeSats >= d.minSizeSats && d.totalSizeSats >= d.maxSizeSats)) {
      setError("Sizes must satisfy 0 < min ≤ max ≤ total.");
      return;
    }
    if (d.baseFeeSats <= 0) {
      setError("Set a base fee above 0.");
      return;
    }
    const editing = editingId;
    const another = !editing && offers.length > 0;
    const promise = feeCaps ? ` It promises buyers a routing fee of at most ${feeCaps.feeRateCapPpm} ppm + ${feeCaps.baseFeeCapSats} sat for the lease.` : "";
    const lease =
      (leaseWarning(d.minBlockLength, rec?.sell.standardLeaseBlocks ?? STANDARD_LEASE_BLOCKS) ?? "") + (pricedLeaseWarning(d.minBlockLength, pricedFor) ?? "");
    const ok = await ui.confirm({
      title: editing ? "Update offer" : another ? "Create ANOTHER offer" : "Create sell offer",
      message: editing
        ? `Update your offer to channels ${satsCompact(d.minSizeSats)}–${satsCompact(d.maxSizeSats)} at ${d.feeRatePpm} ppm + ${d.baseFeeSats} sat base, ${d.minBlockLength} blocks?${promise} The offer becomes yours: the autopilot leaves its terms alone until you hand it back.${lease}`
        : `${another ? "You already have an offer — this lists a SECOND one. " : ""}List ${satsCompact(d.totalSizeSats)} of liquidity (channels ${satsCompact(d.minSizeSats)}–${satsCompact(d.maxSizeSats)} at ${d.feeRatePpm} ppm, ${d.minBlockLength} blocks)?${promise} When someone buys, the channel must be opened in time or your seller score drops.${lease}`,
      confirmLabel: editing ? "Save changes" : another ? "Create another offer" : "Create offer",
    });
    if (!ok) return;
    setBusy(true);
    try {
      if (editing) {
        const res = await api.ambossUpdateOffer(editing, d);
        ui.toast(res.verified === false ? "Amboss answered OK, but the offer reads back different — check it." : "Offer updated.", res.verified === false ? "error" : "success");
      } else {
        await api.ambossCreateOffer(d);
        ui.toast("Offer created.", "success");
      }
      setEditingId(null);
      setDraft(null);
      setPricedFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (o: MyOffer) => {
    if (o.status === "ENABLED" && cfg?.sellEnabled) {
      const ok = await ui.confirm({
        title: "Disable offer",
        message: "Disable this offer? It stays disabled until you enable it again: the autopilot never enables an offer you disabled. Its terms stay with whoever sets them now.",
        confirmLabel: "Disable",
      });
      if (!ok) return;
    }
    setTogglingId(o.id);
    try {
      // By state, not by flip: if the autopilot changed it since this page
      // loaded, a flip would do the opposite of what the button says.
      await api.ambossToggleOffer(o.id, o.status === "ENABLED" ? "DISABLED" : "ENABLED");
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setTogglingId(null);
    }
  };

  const handBack = async (o: MyOffer, managed: boolean) => {
    try {
      await api.ambossOfferAutomation(o.id, managed);
      ui.toast(managed ? "The autopilot manages this offer again from its next run." : "Taken over: the autopilot leaves this offer's terms to you.", "success");
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const copyId = (id: string) => {
    void navigator.clipboard?.writeText(id).then(
      () => ui.toast("Offer id copied — a buyer can order from it directly (market.order.create).", "success"),
      () => ui.toast(id, "info"),
    );
  };

  if (connected === false) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Sell liquidity</h2>
        </div>
        <div className="dryrun-banner">Connect your Amboss API key in <strong>Settings</strong> to create offers.</div>
        <EligibilityCard e={elig} busy={eligBusy} onRefresh={() => loadEligibility(true)} />
        <HowAmbossPicks usdOrderSat={elig?.usdOrders?.minOrderSat ?? null} usdAtOwnPriceSat={elig?.usdOrders?.atOwnPriceSat ?? null} feeTiers={elig?.feeTiers ?? null} />
      </section>
    );
  }

  const mine = offers[0];
  // The recommendation for the offer the price buttons edit (your first one).
  const r0 = (mine && rec?.sell.recommendations.find((r) => r.offerId === mine.id)) || rec?.sell.recommendations[0] || null;
  const summary = rec ? sellSummary(rec, elig) : null;
  const a = rec?.analytics;
  const clearing = r0?.clearing ?? null;
  const leaseDays = r0 ? Math.round(r0.recommended.minBlockLength / 144) : null;
  const managedPrice = autoPriced(mine);
  const sizeWarning = offerSizeWarning(form, cfg, rec?.sell.effectiveMaxOrderSat ?? null);
  // Expected value, not the margin of one sale (m4: the per-sale view made a
  // ≈0-sales feature look profitable): sales a year × what one nets.
  const evPerYear = r0 && elig?.expectedSalesPerYear != null ? Math.round(elig.expectedSalesPerYear * r0.economics.netLeaseProfitSat) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Sell liquidity <span className="v2-badge">advanced</span>
        </h2>
        {a ? (
          <span className="muted">
            {a.mySellerScore != null ? `seller score ${a.mySellerScore.toFixed(1)} · ` : ""}
            {a.filledOrdersAllTime} sold · {sats(a.netProfitSat)} sat net
          </span>
        ) : null}
      </div>
      {keyCheck === "unreachable" ? (
        <p className="banner">
          Amboss is unreachable right now — retrying. Your key stays connected; selling resumes when Amboss answers again.
        </p>
      ) : keyValid === false ? (
        <p className="banner error">
          Amboss rejects your API key (expired or revoked) — Magma selling <strong>does nothing</strong> (no offers managed, no
          orders fulfilled). Connect a fresh key in <strong>Settings</strong>.
        </p>
      ) : null}
      {cfg?.sellEnabled && failedOfferWrite(sync) ? (
        <p className="banner error">The autopilot could not update your offer on Amboss: {failedOfferWrite(sync)}</p>
      ) : null}
      <div className="dryrun-banner">
        <strong>Selling is an advanced feature.</strong> Amboss decides which seller gets an order — mostly sellers with a track
        record. LightningMate makes selling correct and reliable (hold invoices, prompt accepts and rejects, offers it can fund);
        it cannot make Amboss pick you. For most small nodes, a routing channel earns more on the same capital.
      </div>
      {feeBps > 0 ? (
        <p className="fee-note">A {feeBps / 100}% service fee on completed sales supports Lightning Mate’s development.</p>
      ) : null}

      <EligibilityCard e={elig} busy={eligBusy} onRefresh={() => loadEligibility(true)} />
      <SellDiagnosticsCard d={diag} onFix={(tab, sub) => goTo(tab, sub)} />
      <HowAmbossPicks usdOrderSat={elig?.usdOrders?.minOrderSat ?? null} usdAtOwnPriceSat={elig?.usdOrders?.atOwnPriceSat ?? null} feeTiers={elig?.feeTiers ?? null} />

      {rec && summary ? (
        <div className="magma-v2">
          <div className="sug-need">
            <span
              className={`sug-need-tag ${
                summary.good
                  ? "need-balanced"
                  : rec.sell.state === "insufficient_capital" || rec.sell.state === "market_too_cheap"
                    ? "need-need_inbound"
                    : ""
              }`}
              title="Whether a sale at today's prices would beat routing this capital — per sale, not whether a sale will come"
            >
              {summary.label}
            </span>
            <span className="muted">{summary.line}</span>
          </div>
          {rec.sell.reasons.length > 1 || rec.sell.warnings.length ? (
            <div className="magma-warns">
              {rec.sell.reasons.slice(1).map((w, i) => (
                <div key={`r${i}`} className="muted">• {w}</div>
              ))}
              {rec.sell.warnings.map((w, i) => (
                <div key={`w${i}`} className="sug-warn">⚠ {w}</div>
              ))}
            </div>
          ) : null}

          {rec.sell.pendingSellerOrders > 0 ? (
            <div className="magma-warn-banner">
              ⚠ {rec.sell.pendingSellerOrders} order{rec.sell.pendingSellerOrders === 1 ? "" : "s"} waiting on you — accept or
              reject in time (Market → Orders), or Amboss counts it against your seller score.
            </div>
          ) : null}

          <div className="magma-substats muted">
            {rec.sell.projectedMonthlySat > 0 ? (
              <>
                ≈ <b>{sats(rec.sell.projectedMonthlySat)}</b> sat/mo from your own sales of the last 30 days ·{" "}
              </>
            ) : null}
            {rec.sell.medianOrderSat ? (
              <>
                median real order <b>{satsCompact(rec.sell.medianOrderSat)}</b> ·{" "}
              </>
            ) : null}
            standard lease <b>{rec.sell.standardLeaseBlocks} blocks</b> · ~{rec.sell.onchainOpenCostSat} sat to open on-chain
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
                  <span className="magma-stat-label">One sale at this price</span>
                  <span className="magma-stat-val">
                    {r0.economics.leaseApy}% <span className="muted">/yr net · {sats(r0.economics.netLeaseProfitSat)} sat net per sale</span>
                  </span>
                </div>
                <span className={`magma-verdict ${evPerYear !== null && evPerYear > 0 ? "win" : "lose"}`} title="Expected sales a year (offers like yours) × what one sale nets">
                  {evPerYear === null ? "per sale only" : `expected ≈ ${sats(evPerYear)} sat/yr`}
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
                    <span>
                      recommended <b>{r0.recommended.effectiveFeePpm} ppm</b> effective ({r0.recommended.feeRatePpm} + {r0.recommended.baseFeeSat} base)
                    </span>
                  )}
                  {r0.market.myRank ? <span className="muted">your rank #{r0.market.myRank} of {r0.market.segmentCount}</span> : null}
                </div>
                <div className="magma-price-meta muted">
                  {clearing ? (
                    <>
                      {r0.market.sizeBand} band · <b>{clearing.count} real sales</b> in {clearing.windowDays}d paid{" "}
                      {clearing.p25Ppm}–{clearing.p75Ppm} ppm, median {clearing.medianPpm} for a {leaseDays}-day lease · floor{" "}
                      {r0.economics.profitFloorEffectivePpm}
                    </>
                  ) : (
                    <>
                      {r0.market.sizeBand} band · no sale history, using LISTED asks (as {leaseDays}-day prices) · p25 {r0.market.p25} · median{" "}
                      {r0.market.median} · p75 {r0.market.p75} ppm · floor {r0.economics.profitFloorEffectivePpm}
                    </>
                  )}
                  {r0.recommended.feeRateCapPpm !== null ? ` · fee promise ≤ ${r0.recommended.feeRateCapPpm} ppm + ${r0.recommended.baseFeeCapSats} sat` : ""}
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
                        <div className="magma-slider-band" style={{ left: `${pos(m.p25)}%`, width: `${Math.max(1, pos(m.p75) - pos(m.p25))}%` }} />
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
                  {(
                    [
                      ["Low", r0.pricing.fast, "the 25th percentile of what buyers paid (never below your floor)"],
                      ["Median", r0.pricing.balanced, "the median of what buyers paid"],
                      ["High", r0.pricing.premium, "the 75th percentile of what buyers paid"],
                      ["Profit floor", r0.pricing.profitFloor, "the lowest price that still beats routing"],
                    ] as [string, PricePoint, string][]
                  ).map(([label, p, title]) => (
                    <button
                      key={label}
                      className="row-btn"
                      disabled={managedPrice}
                      title={`${title} — for a ${leaseDays}-day lease`}
                      onClick={() => applyPrice(p, r0.recommended.minBlockLength)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="row-btn primary"
                    disabled={managedPrice}
                    title={
                      mine
                        ? `The recommended price, the ${leaseDays}-day lease it is for and the engine's window (within what can be funded) — into your offer's edit form`
                        : undefined
                    }
                    onClick={() => applyPrice(r0.recommended, r0.recommended.minBlockLength, true)}
                  >
                    {mine ? "Apply recommended to my offer" : "Use recommended"}
                  </button>
                </div>
                {managedPrice && !failedOfferWrite(sync) ? (
                  <p className="magma-ap-note muted">
                    The autopilot prices this offer (Auto-price is on).{" "}
                    <button className="linklike" onClick={() => goTo("autopilot", "magma")}>
                      Untick Auto-price
                    </button>{" "}
                    — or edit the offer below to take it over — to price it by hand.
                  </p>
                ) : null}
                {r0.warnings.length || r0.reasons.length ? (
                  <div className="magma-warns">
                    {r0.warnings.map((w, i) => (
                      <div key={`w${i}`} className="sug-warn">⚠ {w}</div>
                    ))}
                    {r0.reasons.map((w, i) => (
                      <div key={`r${i}`} className="muted">• {w}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <h3 className="sub">{editingId ? "Edit your offer" : offers.length ? "New offer (you have one already — this lists another)" : "New offer"}</h3>
      <div className="policy-controls">
        {FIELDS.map((f) => (
          <label key={f.key} className="policy-field" title={f.hint}>
            <span>{f.label}</span>
            <input type="number" min={0} value={form[f.key]} onChange={(e) => setNum(f.key, Number(e.target.value))} />
          </label>
        ))}
        <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? (editingId ? "Saving…" : "Creating…") : editingId ? "Save changes" : offers.length ? "Create another offer" : "Create offer"}
        </button>
        {editingId || draft ? (
          <button className="reset" disabled={busy} onClick={cancelEdit}>
            {editingId ? "Cancel" : "Reset"}
          </button>
        ) : null}
      </div>
      {feeCaps ? <OfferPromiseNote caps={feeCaps} leaseBlocks={form.minBlockLength} standardLeaseBlocks={STANDARD_LEASE_BLOCKS} /> : null}
      {sizeWarning ? <p className="sug-warn">⚠ {sizeWarning}</p> : null}
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
              <th className="num">Fee promise</th>
              <th>Terms set by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => {
              const active = o.status === "ENABLED";
              const owner = ownerOf(o);
              const oddLease = leaseToKeep(o.minBlockLength, rec?.sell.standardLeaseBlocks ?? STANDARD_LEASE_BLOCKS) !== o.minBlockLength;
              return (
                <tr key={o.id} className={active ? "" : "inactive"}>
                  <td>{active ? "🟢 active" : `⚪ ${o.status.toLowerCase()}`}</td>
                  <td className="num">
                    {satsCompact(o.minSizeSats)}–{satsCompact(o.maxSizeSats)}
                  </td>
                  <td className="num">{satsCompact(o.totalSizeSats)}</td>
                  <td className="num">{o.feeRatePpm} ppm</td>
                  <td className="num">{o.baseFeeSats}</td>
                  <td className={`num ${oddLease ? "delta-up" : ""}`} title={`${o.minBlockLength} blocks${oddLease ? " — not the standard lease buyers use" : ""}`}>
                    {Math.round(o.minBlockLength / 144)}d{oddLease ? " ⚠" : ""}
                  </td>
                  <td className="num" title="The routing fee promised to buyers for the lease">
                    {o.feeRateCapPpm ? `≤ ${o.feeRateCapPpm} ppm + ${o.baseFeeCapSats ?? 0} sat` : "none"}
                  </td>
                  <td title={owner.title}>{owner.label}</td>
                  <td>
                    <div className="row-actions">
                      <button className="row-btn ghost" disabled={busy} onClick={() => startEdit(o)}>
                        edit
                      </button>
                      <button className="row-btn ghost" disabled={togglingId !== null} onClick={() => void toggle(o)}>
                        {togglingId === o.id ? "…" : active ? "disable" : "enable"}
                      </button>
                      {owner.yours && cfg?.sellEnabled ? (
                        <button className="row-btn ghost" title="Let the autopilot manage this offer's terms again" onClick={() => void handBack(o, true)}>
                          hand to autopilot
                        </button>
                      ) : null}
                      {!owner.yours && cfg?.sellEnabled ? (
                        <button className="row-btn ghost" title="Keep this offer's terms as they are: the autopilot only keeps it fundable" onClick={() => void handBack(o, false)}>
                          take over
                        </button>
                      ) : null}
                      <button className="row-btn ghost" title="Copy the offer id: a buyer can order from this offer directly" onClick={() => copyId(o.id)}>
                        copy id
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

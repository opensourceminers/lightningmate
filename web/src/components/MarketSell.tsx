import { useEffect, useState } from "react";
import { goTo } from "../nav";
import { api } from "../api";
import {
  EMPTY_REPORT_VIEW,
  forgetMagmaReport,
  reportErrorText,
  reportLoaded,
  reportRefreshFailed,
  sharedMagmaReport,
  type ReportView,
} from "../magmaReport";
import { useVisibleInterval } from "../usePolledData";
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
  baseFeeFollow,
  keepDisabledAction,
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
  /** "Create another offer" pressed: the form for a second offer is open. */
  const [showForm, setShowForm] = useState(false);
  // The report, when it was read (its "as of" — the server's and the views'
  // shared copies make that up to ~2 min before this view got it), and why
  // the last refresh failed — a failure keeps the report it had (the engine
  // fails rather than read 0 sat on chain).
  const [recView, setRecView] = useState<ReportView>(EMPTY_REPORT_VIEW);
  const rec = recView.report;
  const recAt = recView.at;
  const takeReport = (r: MagmaV2Report) => setRecView(reportLoaded(r));
  const reportFailed = (e: unknown) => setRecView((v) => reportRefreshFailed(v, e));
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
    sharedMagmaReport().then(takeReport).catch(reportFailed);
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
  // The report again every minute while the page is visible: its "orders
  // waiting on you" banner went stale — the tab never refreshed it.
  useVisibleInterval(() => void sharedMagmaReport().then(takeReport).catch(reportFailed), 60_000);
  /** After a write here: the next read is fresh, not the shared copy. */
  const reload = async () => {
    forgetMagmaReport();
    await load();
  };

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
    if (d.feeRatePpm <= 0 && d.baseFeeSats <= 0) {
      setError("Set a price: a fee rate, a base fee or both — at 0 ppm + 0 sat buyers would get a channel for free.");
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
      await reload();
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
        message:
          "Disable this offer? While Liquidity provision stays on it stays disabled until you enable it again — switching Liquidity provision " +
          "off and on lists your disabled offers again. Its terms stay with whoever sets them now.",
        confirmLabel: "Disable",
      });
      if (!ok) return;
    }
    setTogglingId(o.id);
    try {
      // By state, not by flip: if the autopilot changed it since this page
      // loaded, a flip would do the opposite of what the button says.
      await api.ambossToggleOffer(o.id, o.status === "ENABLED" ? "DISABLED" : "ENABLED");
      await reload();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setTogglingId(null);
    }
  };

  // "keep disabled" (keepDisabledAction): an offer a switch-on is to list
  // stays off. By state — it is disabled, so nothing is flipped; the click is
  // recorded as a disable by hand, which ends what the switch-on had to list.
  const keepDisabled = async (o: MyOffer) => {
    setTogglingId(o.id);
    try {
      await api.ambossToggleOffer(o.id, "DISABLED");
      ui.toast("Kept disabled: the autopilot leaves it off until you enable it.", "success");
      await reload();
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
      await reload();
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
  /** The engine has a price for this offer (what the autopilot would give it). */
  const enginePriced = (o: MyOffer) => !!rec?.sell.recommendations.some((r) => r.offerId === o.id && (r.recommended.feeRatePpm > 0 || r.recommended.baseFeeSat > 0));
  const sizeWarning = offerSizeWarning(form, cfg, rec?.sell.effectiveMaxOrderSat ?? null);
  // Expected value, not the margin of one sale (m4: the per-sale view made a
  // ≈0-sales feature look profitable): sales a year × what one nets.
  const evPerYear = r0 && elig?.expectedSalesPerYear != null ? Math.round(elig.expectedSalesPerYear * r0.economics.netLeaseProfitSat) : null;
  // The offer form only when it is wanted: editing, a price button pressed,
  // no offer yet, or "Create another offer" (it sat open under everything,
  // with a paragraph of fine print, on every visit).
  const formOpen = editingId !== null || draft !== null || showForm || (connected !== null && offers.length === 0);

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
      {rec && rec.sell.pendingSellerOrders > 0 ? (
        <div className="magma-warn-banner">
          ⚠ {rec.sell.pendingSellerOrders} order{rec.sell.pendingSellerOrders === 1 ? "" : "s"} waiting on you — accept or reject in
          time (Market → Orders), or Amboss counts it against your seller score.
        </div>
      ) : null}
      <p className="sell-lede muted">
        Amboss decides who gets an order — mostly sellers with a track record. LightningMate makes selling correct and reliable; it
        can't make Amboss pick you.
        {feeBps > 0 ? ` A ${feeBps / 100}% service fee on completed sales supports Lightning Mate’s development.` : ""}
      </p>

      <h3 className="sub">{offers.length > 1 ? "Your offers" : "Your offer"}</h3>
      {connected === null ? (
        <p className="muted">Loading…</p>
      ) : offers.length === 0 ? (
        <EmptyState icon="🏷️">No offer yet — create one below.</EmptyState>
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
              const free = o.feeRatePpm <= 0 && o.baseFeeSats <= 0;
              const keep = keepDisabledAction(o, controls[o.id]);
              const follow = baseFeeFollow(o, rec, autoPriced(o));
              return (
                <tr key={o.id} className={active ? "" : "inactive"}>
                  <td>{active ? "🟢 active" : `⚪ ${o.status.toLowerCase()}`}</td>
                  <td className="num">
                    {satsCompact(o.minSizeSats)}–{satsCompact(o.maxSizeSats)}
                  </td>
                  <td className="num">{satsCompact(o.totalSizeSats)}</td>
                  <td className={`num ${free ? "delta-up" : ""}`} title={free ? "No price: buyers would get a channel for free" : undefined}>
                    {o.feeRatePpm} ppm{free ? " ⚠" : ""}
                  </td>
                  <td className="num" title={follow?.title}>
                    {o.baseFeeSats}
                    {follow ? <span className="base-follow"> {follow.cell}</span> : null}
                  </td>
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
                      <button
                        className="row-btn ghost"
                        disabled={togglingId !== null || (!active && free)}
                        title={
                          !active && free
                            ? autoPriced(o) && enginePriced(o)
                              ? "No price yet: the autopilot gives it one at its next run — then enable it"
                              : "Set a price first (edit): listed like this, buyers would get a channel for free"
                            : undefined
                        }
                        onClick={() => void toggle(o)}
                      >
                        {togglingId === o.id ? "…" : active ? "disable" : "enable"}
                      </button>
                      {keep ? (
                        <button className="row-btn ghost" disabled={togglingId !== null} title={keep.title} onClick={() => void keepDisabled(o)}>
                          {keep.label}
                        </button>
                      ) : null}
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

      {offers.some((o) => o.status !== "ENABLED" && o.feeRatePpm <= 0 && o.baseFeeSats <= 0) ? (
        <p className="sug-warn">
          ⚠ {offers.some((o) => o.status !== "ENABLED" && o.feeRatePpm <= 0 && o.baseFeeSats <= 0 && autoPriced(o) && enginePriced(o))
            ? "This offer has no price on Amboss (0 ppm + 0 sat). The autopilot gives it the recommended one at its next run — then enable it. Listing it again is your click."
            : "This offer has no price on Amboss (0 ppm + 0 sat). Give it one with edit, then enable it."}
        </p>
      ) : null}
      {formOpen ? (
        <div className="offer-form">
          <h4 className="sub">{editingId ? "Edit your offer" : offers.length ? "Another offer (it lists a second one)" : "New offer"}</h4>
          <div className="policy-controls">
            {FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={form[f.key]} onChange={(e) => setNum(f.key, Number(e.target.value))} />
                {/* On the page, not only in a tooltip (touch screens have none). */}
                <span className="field-hint">{f.hint}</span>
              </label>
            ))}
            <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
              {busy ? (editingId ? "Saving…" : "Creating…") : editingId ? "Save changes" : offers.length ? "Create another offer" : "Create offer"}
            </button>
            {editingId || draft || showForm ? (
              <button
                className="reset"
                disabled={busy}
                onClick={() => {
                  cancelEdit();
                  setShowForm(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {feeCaps ? <OfferPromiseNote caps={feeCaps} leaseBlocks={form.minBlockLength} standardLeaseBlocks={STANDARD_LEASE_BLOCKS} /> : null}
          {sizeWarning ? <p className="sug-warn">⚠ {sizeWarning}</p> : null}
        </div>
      ) : offers.length > 0 ? (
        <button className="row-btn ghost add-offer" onClick={() => setShowForm(true)}>
          + Create another offer
        </button>
      ) : null}
      {error ? <p className="banner error">{error}</p> : null}

      {rec && r0 ? (
        <>
          <h3 className="sub">Price</h3>
          <div className="magma-price-card">
            <div className="magma-price-head">
              <span className={`feerec-state ${SELL_STATE_CLASS[r0.state]}`}>{SELL_STATE_LABEL[r0.state]}</span>
              {r0.current ? (
                <span>
                  yours <b>{r0.current.effectiveFeePpm}</b> → recommended{" "}
                  <b className={r0.recommended.effectiveFeePpm > r0.current.effectiveFeePpm ? "delta-up" : r0.recommended.effectiveFeePpm < r0.current.effectiveFeePpm ? "delta-down" : ""}>
                    {r0.recommended.effectiveFeePpm}
                  </b>{" "}
                  ppm
                </span>
              ) : (
                <span>
                  recommended <b>{r0.recommended.effectiveFeePpm} ppm</b> ({r0.recommended.feeRatePpm} + {r0.recommended.baseFeeSat} base)
                </span>
              )}
              {evPerYear !== null ? (
                <span className={`magma-verdict ${evPerYear > 0 ? "win" : "lose"}`} title="Expected sales a year (offers like yours) × what one sale nets">
                  expected ≈ {sats(evPerYear)} sat/yr
                </span>
              ) : null}
            </div>
            <div className="magma-price-meta muted">
              {clearing
                ? `buyers paid ${clearing.p25Ppm}–${clearing.p75Ppm} ppm (median ${clearing.medianPpm}) in ${clearing.count} sales of the last ${clearing.windowDays} days · one sale nets ~${sats(r0.economics.netLeaseProfitSat)} sat`
                : `no sale history: priced against listed asks (median ${r0.market.median} ppm) · one sale nets ~${sats(r0.economics.netLeaseProfitSat)} sat`}
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
                    <span className="magma-leg"><i className="magma-dot median" />listed median {m.median}</span>
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
                — or edit the offer to take it over — to price it by hand.
              </p>
            ) : null}
            {r0.warnings.length ? (
              <div className="magma-warns">
                {r0.warnings.map((w, i) => (
                  <div key={`w${i}`} className="sug-warn">⚠ {w}</div>
                ))}
              </div>
            ) : null}
            <details className="price-more">
              <summary>Why this price</summary>
              {summary ? (
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
              ) : null}
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
              </div>
              <div className="magma-warns">
                <div className="muted">
                  • {r0.market.sizeBand} band · lease {leaseDays} days · profit floor {r0.economics.profitFloorEffectivePpm} ppm
                  {r0.recommended.feeRateCapPpm !== null ? ` · fee promise ≤ ${r0.recommended.feeRateCapPpm} ppm + ${r0.recommended.baseFeeCapSats} sat` : ""}
                  {r0.market.myRank ? ` · your rank #${r0.market.myRank} of ${r0.market.segmentCount}` : ""}
                </div>
                <div className="muted">
                  • {rec.sell.medianOrderSat ? `median real order ${satsCompact(rec.sell.medianOrderSat)} · ` : ""}standard lease {rec.sell.standardLeaseBlocks} blocks · ~
                  {rec.sell.onchainOpenCostSat} sat to open on-chain
                  {rec.sell.projectedMonthlySat > 0 ? ` · ≈ ${sats(rec.sell.projectedMonthlySat)} sat/mo from your own sales of the last 30 days` : ""}
                  {rec.sell.pricingMode === "auto" ? ` · auto level ${Math.round(rec.sell.adaptiveLevel * 100)}%` : ""}
                  {recAt ? ` · as of ${new Date(recAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                </div>
                {[...rec.sell.reasons.slice(1), ...r0.reasons].map((w, i) => (
                  <div key={`r${i}`} className="muted">• {w}</div>
                ))}
                {rec.sell.warnings.map((w, i) => (
                  <div key={`sw${i}`} className="sug-warn">⚠ {w}</div>
                ))}
              </div>
            </details>
          </div>
        </>
      ) : rec && summary ? (
        <div className="sug-need">
          <span className="sug-need-tag">{summary.label}</span>
          <span className="muted">{summary.line}</span>
        </div>
      ) : null}
      {recView.error ? <p className="banner error">{reportErrorText(recView)}</p> : null}

      <EligibilityCard e={elig} busy={eligBusy} onRefresh={() => loadEligibility(true)} />
      <SellDiagnosticsCard d={diag} onFix={(tab, sub) => goTo(tab, sub)} />
      <HowAmbossPicks usdOrderSat={elig?.usdOrders?.minOrderSat ?? null} usdAtOwnPriceSat={elig?.usdOrders?.atOwnPriceSat ?? null} feeTiers={elig?.feeTiers ?? null} />
    </section>
  );
}

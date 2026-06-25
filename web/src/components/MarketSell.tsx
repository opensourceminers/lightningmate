import { useEffect, useState } from "react";
import { api } from "../api";
import type { MyOffer } from "../types";
import { satsCompact } from "../format";
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

const median = (arr: number[]): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// q-th percentile (0..1) — used for a competitive "price to sell" suggestion.
const percentile = (arr: number[], q: number): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

const FIELDS: { key: keyof Draft; label: string; hint: string }[] = [
  { key: "totalSizeSats", label: "Total (sat)", hint: "total liquidity you'll sell across orders" },
  { key: "minSizeSats", label: "Min channel (sat)", hint: "smallest channel a buyer can order" },
  { key: "maxSizeSats", label: "Max channel (sat)", hint: "largest channel a buyer can order" },
  { key: "feeRatePpm", label: "Fee rate (ppm)", hint: "lease fee per sat of channel size" },
  { key: "baseFeeSats", label: "Base fee (sat)", hint: "flat fee added per order" },
  { key: "minBlockLength", label: "Min lease (blocks)", hint: "how long the channel must stay open (~144 blocks/day)" },
];

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
  const [ref, setRef] = useState<{ feeMin: number; feeComp: number; feeMed: number; baseMed: number } | null>(null);

  const load = async () => {
    // Live market reference (no key needed) — orientation for your pricing.
    try {
      const m = await api.ambossMarket();
      const fees = m.offers.map((o) => o.feeRatePpm).filter((n) => n > 0);
      const bases = m.offers.map((o) => o.baseFeeSats).filter((n) => n > 0);
      if (fees.length)
        setRef({
          feeMin: Math.min(...fees),
          feeComp: percentile(fees, 0.25),
          feeMed: median(fees),
          baseMed: median(bases),
        });
    } catch {
      // reference is best-effort
    }
    try {
      const s = await api.ambossStatus();
      setConnected(s.connected);
      setFeeBps(s.saleFeeBps ?? 0);
      if (s.connected) setOffers((await api.ambossMyOffers()).offers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnected(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setNum = (k: keyof Draft, v: number) =>
    setDraft((d) => ({ ...d, [k]: Math.max(0, Math.floor(v) || 0) }));

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
        ? `Update your offer to channels ${satsCompact(draft.minSizeSats)}–${satsCompact(draft.maxSizeSats)} ` +
          `at ${draft.feeRatePpm} ppm + ${draft.baseFeeSats} sat base?`
        : `List ${satsCompact(draft.totalSizeSats)} of liquidity (channels ${satsCompact(draft.minSizeSats)}–` +
          `${satsCompact(draft.maxSizeSats)} at ${draft.feeRatePpm} ppm)? When someone buys, you must open ` +
          `a channel to them in time or your seller score drops.`,
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
        <div className="dryrun-banner">
          Connect your Amboss API key in <strong>Settings</strong> to create offers.
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Sell liquidity <span className="muted">· your offers</span>
        </h2>
      </div>
      <div className="dryrun-banner">
        List channel liquidity for sale on Magma. <strong>Important:</strong> when a buyer orders you
        must open a channel to them within the time window, or your seller score drops — the Autopilot
        can handle this for you automatically (enable <strong>Liquidity provision</strong>).
      </div>
      {feeBps > 0 ? (
        <p className="fee-note">
          A {feeBps / 100}% service fee on completed sales supports Lightning Mate’s development.
        </p>
      ) : null}

      {ref ? (
        <div className="market-ref">
          <span>
            Market — <strong>{ref.feeMin} ppm</strong> lowest · <strong>{ref.feeComp} ppm</strong>{" "}
            competitive (p25) · <strong>{ref.feeMed} ppm</strong> median · base{" "}
            <strong>{ref.baseMed} sat</strong>
          </span>
          <div className="row-actions">
            <button
              className="row-btn"
              title="Undercut ~75% of the market to win orders"
              onClick={() => setDraft((d) => ({ ...d, feeRatePpm: ref.feeComp, baseFeeSats: ref.baseMed }))}
            >
              price to sell
            </button>
            <button
              className="row-btn ghost"
              onClick={() => setDraft((d) => ({ ...d, feeRatePpm: ref.feeMed, baseFeeSats: ref.baseMed }))}
            >
              match median
            </button>
          </div>
        </div>
      ) : null}

      <div className="policy-controls">
        {FIELDS.map((f) => (
          <label key={f.key} className="policy-field" title={f.hint}>
            <span>{f.label}</span>
            <input
              type="number"
              min={0}
              value={draft[f.key]}
              onChange={(e) => setNum(f.key, Number(e.target.value))}
            />
          </label>
        ))}
        <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? (editingId ? "Saving…" : "Creating…") : editingId ? "Save changes" : "Create offer"}
        </button>
        {editingId ? (
          <button className="reset" disabled={busy} onClick={cancelEdit}>
            Cancel
          </button>
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
                  <td className="num">
                    {satsCompact(o.minSizeSats)}–{satsCompact(o.maxSizeSats)}
                  </td>
                  <td className="num">{satsCompact(o.totalSizeSats)}</td>
                  <td className="num">{o.feeRatePpm} ppm</td>
                  <td className="num">{o.baseFeeSats}</td>
                  <td className="num">{Math.round(o.minBlockLength / 144)}d</td>
                  <td>
                    <div className="row-actions">
                      <button className="row-btn ghost" disabled={busy} onClick={() => startEdit(o)}>
                        edit
                      </button>
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

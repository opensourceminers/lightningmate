import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { caretButtonProps } from "../a11y";
import type { AutopilotChange, FeeMode, FeeRecReport, FeeRecState, OverrideMap } from "../types";
import { satsCompact, timeAgo } from "../format";
import { applyChannelIds, baseChange, marketRefText } from "../feeView";
import { FeeOverrideControl } from "./FeeOverrideControl";

const STATE_LABEL: Record<FeeRecState, string> = {
  normal: "normal",
  exploring_lower_fee: "exploring ↓",
  protecting_liquidity: "protecting",
  recovering_cost: "recovering cost",
  close_candidate: "close candidate",
};
const STATE_CLASS: Record<FeeRecState, string> = {
  normal: "s-normal",
  exploring_lower_fee: "s-explore",
  protecting_liquidity: "s-protect",
  recovering_cost: "s-cost",
  close_candidate: "s-close",
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * What "Apply N" did. A write that did not happen is "not applied" — LND
 * refusing it is one reason, a channel skipped because its current policy
 * could not be read (so its timelock is never reset blindly) another: it read
 * "refused by LND" for both. Each one's reason is in the tooltip.
 */
export function ApplyResult({ applied }: { applied: AutopilotChange[] }) {
  const ok = applied.filter((c) => c.ok);
  const failed = applied.filter((c) => !c.ok);
  const clamped = ok.filter((c) => c.clampedBy).length;
  return (
    <span className="apply-result">
      ✓ {ok.length} applied
      {clamped ? ` (${clamped} kept within a lease's fee promise)` : ""}
      {failed.length ? (
        <span className="warn" title={failed.map((c) => `${c.alias}: ${c.error ?? "not applied"}`).join("\n")}>
          {" "}
          · {failed.length} not applied
        </span>
      ) : null}
    </span>
  );
}

/**
 * Channels that keep refusing HTLCs for lack of outbound (D20). The signal is
 * de-noised but still a heuristic — probes of varying sizes under half the
 * channel, or a payment re-split into parts, count as attempts — so it is
 * POSSIBLE demand, never "real payments" (P2 final review).
 */
export const IN_DEMAND_CHIP_TITLE =
  "Possible demand: refused HTLCs a refilled channel could have carried (probes, retries of the same amount and HTLCs over half the channel excluded)";
export const POSSIBLE_DEMAND_BANNER = "possible demand (refused HTLCs, de-noised)";

export function InDemandChip({ count }: { count: number }) {
  return count ? (
    <span className="feerec-chip s-protect" title={IN_DEMAND_CHIP_TITLE}>
      {count} with possible demand
    </span>
  ) : null;
}

export function FeeRecommendations() {
  const [data, setData] = useState<FeeRecReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AutopilotChange[] | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const load = () =>
    api
      .feesRecommendations()
      .then((r) => (setData(r), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    api.overrides().then(setOverrides).catch(() => {});
  }, []);

  // A refused save rejects: the control shows why.
  const setOv = async (id: string, mode: FeeMode, fixedPpm?: number) => {
    await api.setOverride(id, mode, fixedPpm);
    setOverrides(await api.overrides());
    await load();
  };

  const wouldApply = data?.recommendations.filter((r) => r.wouldApply) ?? [];
  // "Apply N": the server recomputes these rows and applies what the engine
  // recommends — the target AND the base fee — on the autopilot's books
  // (cooldown, run history, fee-change log), like its own changes.
  const apply = async () => {
    const ids = applyChannelIds(data?.recommendations ?? []);
    if (!ids.length) return;
    setApplying(true);
    setApplied(null);
    try {
      const res = await api.feesApplyRecommended(ids);
      setApplied(res.changes);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };
  return (
    <section className="panel feerec">
      <div className="panel-head">
        <h2>
          Smart fees
        </h2>
        <div className="head-actions">
          {data ? <span className="change-badge">{wouldApply.length} to change</span> : null}
          {canWrite && wouldApply.length > 0 ? (
            <button className="primary-btn" disabled={applying} onClick={() => void apply()}>
              {applying ? "Applying…" : `Apply ${wouldApply.length}`}
            </button>
          ) : null}
          {applied != null ? <ApplyResult applied={applied} /> : null}
          <button className="reset" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "only changes" : "show all"}
          </button>
        </div>
      </div>

      <div className="dryrun-banner">
        The fees the autopilot applies when <strong>Fee automation</strong> is on — protect nearly-drained
        channels, price draining channels toward what refilling them costs, keep a price that wins flow, react to
        {" "}{POSSIBLE_DEMAND_BANNER}. Each update moves a fee by a small, bounded step toward its aim (protecting a drained channel
        ramps faster; a drained channel that keeps selling at its fee rises by a quarter of it per move — the demand ramp). A fee
        goes up only when something says the channel drains, or a floor or your min needs it — never just back toward your
        balanced level — and an ordinary raise only after a sale at the fee it charges now; a raise nothing sold at for 48 h
        steps back to the last price that sold. Only these move in one update: an idle channel dropping to the
        price that last won it flow or to what the market charges into its peer, a fee you pinned, a new
        channel&apos;s protected fee, a broken lease promise, and a fee outside your min/max (one below your min goes
        to the min, and steps on from there). Apply them now, or let the autopilot manage them.
        {canWrite ? null : <> Applying is disabled (read-only macaroon).</>}
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      {!data && !error ? <p className="muted">Computing recommendations…</p> : null}

      {data ? (
        <>
          <div className="feerec-chips">
            {(["protecting_liquidity", "recovering_cost", "exploring_lower_fee", "close_candidate"] as FeeRecState[]).map((s) => {
              const n = data.recommendations.filter((r) => r.state === s).length;
              return n ? (
                <span key={s} className={`feerec-chip ${STATE_CLASS[s]}`}>
                  {n} {STATE_LABEL[s]}
                </span>
              ) : null;
            })}
            {(() => {
              const below = data.recommendations.filter((r) => r.metrics.belowReplacement).length;
              return below ? (
                <span className="feerec-chip s-cost" title="Draining, and priced below what refilling them costs on the market">
                  {below} sold below refill cost
                </span>
              ) : null;
            })()}
            <InDemandChip count={data.recommendations.filter((r) => r.metrics.inDemand).length} />
            <span className="feerec-bench muted">
              node median {data.nodeBenchmarks.medianGrossFlow14d.toFixed(2)}× flow/14d ·{" "}
              {Math.round(data.nodeBenchmarks.medianRevenuePpm30d)} ppm earned (median)
              {data.marketReferenced ? ` · market reference for ${data.marketReferenced} channels (public graph)` : ""}
              {" · "}
              <span title="It needs 4 measured changes on a channel that agree, with 10+ forwards before and after each">
                {data.elasticityLearned
                  ? `learned elasticity on ${data.elasticityLearned} channel${data.elasticityLearned === 1 ? "" : "s"}`
                  : "no channel has enough measured fee changes to learn from yet"}
              </span>
            </span>
          </div>

          <table className="fee-table feerec-table">
            <thead>
              <tr>
                <th></th>
                <th>Channel</th>
                <th className="num">Local</th>
                <th className="num">Current → Target</th>
                <th>State</th>
                <th>Manage</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {[...data.recommendations]
                .filter((r) => showAll || r.state !== "normal" || r.wouldApply || overrides[r.channelId])
                .sort(
                  (a, b) =>
                    Number(b.wouldApply) - Number(a.wouldApply) ||
                    Math.abs(b.targetPpm - b.currentPpm) - Math.abs(a.targetPpm - a.currentPpm),
                )
                .map((r) => {
                  const isOpen = open.has(r.channelId);
                  const cls = r.targetPpm > r.currentPpm ? "delta-up" : r.targetPpm < r.currentPpm ? "delta-down" : "";
                  const m = r.metrics;
                  const base = baseChange(r);
                  return (
                    <Fragment key={r.channelId}>
                      <tr className={`feerec-row ${r.wouldApply ? "changing" : ""}`} onClick={() => toggle(r.channelId)}>
                        <td className="feerec-caret">
                          <button {...caretButtonProps(isOpen, () => toggle(r.channelId), `Why: ${r.alias}`)}>{isOpen ? "▾" : "▸"}</button>
                        </td>
                        <td>
                          {r.alias}
                          {m.isTopEarner ? <span className="top-earner" title="top earner"> ★</span> : null}
                        </td>
                        <td className="num">{pct(m.localRatio)}</td>
                        <td className="num">
                          <span className="muted">{r.currentPpm}</span> → <strong className={cls}>{r.targetPpm}</strong>
                          {r.aimPpm !== r.targetPpm && !r.pinned ? (
                            <span className="muted small" title="where the engine is heading — it moves by small steps">
                              {" "}
                              (aim {r.aimPpm})
                            </span>
                          ) : null}
                          {base ? <div className="muted small">{base}</div> : null}
                        </td>
                        <td>
                          <span className={`feerec-state ${STATE_CLASS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                          {r.wouldApply ? <span className="apply-yes" title="would change"> ✓</span> : null}
                        </td>
                        <td className="ov-cell" onClick={(e) => e.stopPropagation()}>
                          <FeeOverrideControl
                            variant="buttons"
                            ov={overrides[r.channelId]}
                            currentPpm={r.currentPpm}
                            onSave={(mode, ppm) => setOv(r.channelId, mode, ppm)}
                          />
                        </td>
                        <td className="muted reason">{r.reasons[0]}</td>
                      </tr>
                      {isOpen ? (
                        <tr className="feerec-detail-row">
                          <td></td>
                          <td colSpan={6}>
                            <div className="feerec-detail">
                              <div className="feerec-reasons">
                                {r.reasons.map((x, i) => (
                                  <div key={i}>• {x}</div>
                                ))}
                                {r.blockedByGuards.map((g, i) => (
                                  <div key={`g${i}`} className="muted">
                                    ⊘ guard: {g}
                                  </div>
                                ))}
                              </div>
                              <div className="feerec-metrics">
                                <span>14d flow <b>{satsCompact(m.routedOut14d)}↑ / {satsCompact(m.routedIn14d)}↓</b></span>
                                <span>gross <b>{m.grossFlow14d.toFixed(2)}×</b> · net drain <b>{pct(m.netDrain14d)}</b></span>
                                <span>earned 30d <b>{satsCompact(m.revenue30d)} sat</b>{m.revenuePpm30d != null ? ` · ${m.revenuePpm30d} ppm` : ""}</span>
                                <span>
                                  base fee <b>{r.currentBaseMsat} msat</b>
                                  {r.recommendedBaseMsat !== r.currentBaseMsat ? ` → ${r.recommendedBaseMsat}` : ""}
                                </span>
                                <span>
                                  market into peer <b>{marketRefText(m)}</b>
                                  {m.marketComparison === "above" ? " · you charge far more" : m.marketComparison === "below" ? " · you charge far less" : ""}
                                </span>
                                <span>
                                  refill costs at least{" "}
                                  <b className={m.belowReplacement ? "warn" : undefined}>
                                    {m.replacementCostPpm != null ? `~${m.replacementCostPpm} ppm` : "—"}
                                  </b>
                                  {m.belowReplacement ? " · sold below it" : ""}
                                </span>
                                <span>
                                  refills still here <b>{m.costBasisPpm != null ? `${satsCompact(m.refillRemainingSats)} at ${m.costBasisPpm} ppm` : "—"}</b>
                                  {m.costBasisPpm != null
                                    ? ` (${m.costBasisRefills} autopilot refill${m.costBasisRefills === 1 ? "" : "s"}${m.costBasisLatestAt ? `, latest ${timeAgo(m.costBasisLatestAt)}` : ""})`
                                    : ""}
                                  {m.profitFloorPpm != null
                                    ? ` · floor ${m.profitFloorPpm}${m.refillHoldPpm != null ? " (the refill's value, until its sats have routed out)" : ""}${m.profitFloorCapped ? " (capped at max)" : ""}`
                                    : m.profitFloorReleased
                                      ? " · floor released (low flow)"
                                      : ""}
                                </span>
                                {m.refusedAttempts14d ? (
                                  <span>
                                    possible demand <b>{m.refusedAttempts14d} refused HTLCs</b> ({satsCompact(m.refusedSats14d)} sat, {m.refusedDays14d} d) in 14 d
                                  </span>
                                ) : null}
                                {m.elasticityMod !== 1 ? <span>elasticity <b>×{m.elasticityMod}</b> (measured)</span> : null}
                                {r.state === "protecting_liquidity" ? (
                                  <span className="muted">
                                    still wanted while drained: an inbound discount on this channel (LND 0.18+, experimental) would make the
                                    payments that refill it cheaper, paid only when they come — set it by hand if you want it; the autopilot
                                    doesn&apos;t
                                  </span>
                                ) : null}
                                <span>peer <b className={m.peerGate === "ok" ? "ok" : "warn"}>{m.peerGate}</b> · {m.role} · target {pct(m.targetLocalRatio)}{m.channelAgeDays != null ? ` · ${m.channelAgeDays}d old` : ""}</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

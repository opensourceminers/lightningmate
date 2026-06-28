import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { sats } from "../format";
import type {
  BackupHealthState,
  BackupHealthStatus,
  ChannelRiskStatus,
  ChannelRiskType,
  LiquiditySafetyStatus,
  OnchainSafetyStatus,
  PaymentReadinessStatus,
  SecurityCategoryScore,
  SecurityIssue,
  SecurityRecommendation,
  SecuritySeverity,
  SecuritySummary,
} from "../types";
import { SkeletonPanel } from "./Skeleton";

const REFRESH_MS = 60_000;

// ── small helpers ─────────────────────────────────────────────────────────────

function pct(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

function satLabel(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return `${sats(value)} sat`;
}

function formatWhen(iso?: string): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

const SEV_LABEL: Record<SecuritySeverity, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
};

function SeverityBadge({ severity }: { severity: SecuritySeverity }) {
  return <span className={`sec-badge sev-${severity}`}>{SEV_LABEL[severity]}</span>;
}

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ── overall score ─────────────────────────────────────────────────────────────

function ScoreCard({ data }: { data: SecuritySummary }) {
  const s = data.score;
  return (
    <section className={`panel sec-score sev-border-${s.severity}`}>
      <div className="sec-score-row">
        <div className={`sec-score-dial sev-bg-${s.severity}`}>
          <div className={`sec-score-num sev-text-${s.severity}`}>{s.score}</div>
          <div className="sec-score-max">/ 100</div>
        </div>
        <div className="sec-score-body">
          <div className="sec-score-head">
            <h2>Security score</h2>
            <SeverityBadge severity={s.severity} />
            <span className="sec-net">{data.dataAvailability.network}</span>
          </div>
          <p className="sec-score-summary">{s.summary}</p>
          <p className="muted sec-score-time">Last checked {formatTime(s.lastUpdatedAt)}</p>
        </div>
      </div>
    </section>
  );
}

const CATEGORY_CARDS: {
  key: keyof SecuritySummary["score"]["categories"];
  title: string;
}[] = [
  { key: "nodeHealth", title: "Node health" },
  { key: "backupHealth", title: "Backup watchdog" },
  { key: "paymentReadiness", title: "Payment readiness" },
  { key: "channelRisk", title: "Channel risk" },
  { key: "onchainSafety", title: "On-chain reserve" },
  { key: "liquiditySafety", title: "Liquidity" },
];

function CategoryGrid({ data }: { data: SecuritySummary }) {
  return (
    <div className="sec-cat-grid">
      {CATEGORY_CARDS.map((c) => {
        const cat = data.score.categories[c.key] as SecurityCategoryScore;
        const line = cat.reasons[0] ?? cat.warnings[0] ?? "";
        return (
          <div key={c.key} className={`sec-cat sev-border-${cat.severity}`}>
            <div className="sec-cat-head">
              <span className="sec-cat-title">{c.title}</span>
              <span className={`sec-cat-score sev-text-${cat.severity}`}>{cat.score}</span>
            </div>
            <div className={`sec-cat-bar sev-bar-${cat.severity}`}>
              <i style={{ width: `${cat.score}%` }} />
            </div>
            {line ? <p className="sec-cat-line">{line}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── issues + recommendations ───────────────────────────────────────────────────

function Issues({ issues }: { issues: SecurityIssue[] }) {
  if (issues.length === 0) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Issues</h2>
        </div>
        <p className="muted">No issues detected. Your node is in good shape.</p>
      </section>
    );
  }
  const critical = issues.filter((i) => i.severity === "critical");
  const ordered = [...critical, ...issues.filter((i) => i.severity !== "critical")];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{critical.length > 0 ? "Critical issues" : "Issues"}</h2>
      </div>
      <div className="sec-list">
        {ordered.map((issue) => (
          <div key={issue.id} className={`sec-item sev-side-${issue.severity}`}>
            <div className="sec-item-head">
              <strong>{issue.title}</strong>
              <SeverityBadge severity={issue.severity} />
            </div>
            <p className="sec-item-desc">{issue.description}</p>
            {issue.reasons.length > 1 ? (
              <ul className="sec-reasons">
                {issue.reasons.slice(1).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function Recommendations({ recs }: { recs: SecurityRecommendation[] }) {
  if (recs.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recommendations</h2>
      </div>
      <div className="sec-list">
        {recs.map((rec) => (
          <div key={rec.id} className="sec-item">
            <div className="sec-item-head">
              <strong>{rec.title}</strong>
              <span className={`sec-prio prio-${rec.priority}`}>
                {PRIORITY_LABEL[rec.priority] ?? rec.priority}
              </span>
            </div>
            <p className="sec-item-desc">{rec.description}</p>
            {rec.reasons.length > 0 ? (
              <ul className="sec-reasons">
                {rec.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── reasons/warnings shared block ──────────────────────────────────────────────

function Notes({ reasons, warnings }: { reasons: string[]; warnings: string[] }) {
  if (reasons.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="sec-notes">
      {reasons.map((r, i) => (
        <li key={`r-${i}`} className="muted">
          {r}
        </li>
      ))}
      {warnings.map((w, i) => (
        <li key={`w-${i}`} className="sec-warn">
          {w}
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="an-card">
      <span className="an-card-label">{label}</span>
      <span className={`an-card-val ${tone ?? ""}`} style={{ fontSize: 17 }}>
        {value}
      </span>
    </div>
  );
}

// ── backup watchdog ─────────────────────────────────────────────────────────────

const BACKUP_STATE_LABEL: Record<BackupHealthState, string> = {
  current: "Current",
  stale: "Stale",
  missing: "Missing",
  unknown: "Unknown",
  needs_export_after_channel_change: "Export needed (channels changed)",
};

const BACKUP_NOTE =
  "LightningMate never asks for or stores your seed phrase. Store your channel backup encrypted and outside this device.";

function BackupPanel({ data, onExported }: { data: BackupHealthStatus; onExported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const token = localStorage.getItem("lm_token") ?? "";
      const res = await fetch("/api/security/backup/export", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let detail = `Export failed (${res.status}).`;
        try {
          const body = await res.json();
          if (body?.message) detail = body.message;
        } catch {
          /* binary or empty body */
        }
        setError(detail);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `channel-SCB-${new Date().toISOString().replace(/[:.]/g, "-")}.backup`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const count = res.headers.get("X-Channel-Count");
      setMessage(`Backup exported${count ? ` for ${count} channel(s)` : ""}. Store it encrypted, off this device.`);
      onExported();
    } catch {
      setError("Could not reach the export endpoint.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Backup watchdog</h2>
        <SeverityBadge severity={data.severity} />
      </div>
      <div className="an-card-grid">
        <Stat label="Backup state" value={BACKUP_STATE_LABEL[data.state]} />
        <Stat label="Last backup" value={formatWhen(data.lastBackupAt)} />
        <Stat label="Channels now" value={data.currentChannelCount} />
        {data.lastKnownChannelCount !== undefined ? (
          <Stat label="Channels at last backup" value={data.lastKnownChannelCount} />
        ) : null}
        <Stat label="SCB export" value={data.canExportScb ? "Available" : "Unavailable"} />
      </div>

      {data.channelChangesSinceLastBackup ? (
        <p className="muted sec-small">
          Since last backup — opened: {data.channelChangesSinceLastBackup.opened}, closed:{" "}
          {data.channelChangesSinceLastBackup.closed}, pending: {data.channelChangesSinceLastBackup.pending}
        </p>
      ) : null}

      <Notes reasons={data.reasons} warnings={data.warnings} />

      <div className="sec-actions">
        <button
          type="button"
          className="sec-btn"
          onClick={handleExport}
          disabled={busy || !data.canExportScb}
        >
          {busy ? "Exporting…" : "Export channel backup"}
        </button>
        {!data.canExportScb ? (
          <span className="muted sec-small">Export requires offchain:read on the macaroon.</span>
        ) : null}
      </div>

      {message ? <p className="sec-ok sec-small">{message}</p> : null}
      {error ? <p className="sec-err sec-small">{error}</p> : null}

      <p className="dryrun-banner sec-note">🔒 {BACKUP_NOTE}</p>
    </section>
  );
}

// ── payment readiness ────────────────────────────────────────────────────────────

function PaymentReadiness({ data }: { data: PaymentReadinessStatus }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Payment readiness</h2>
        <SeverityBadge severity={data.severity} />
      </div>
      <div className="sec-chips">
        <span className={`sec-chip ${data.canLikelySend ? "ok" : "off"}`}>
          {data.canLikelySend ? "Can likely send" : "Cannot send"}
        </span>
        <span className={`sec-chip ${data.canLikelyReceive ? "ok" : "off"}`}>
          {data.canLikelyReceive ? "Can likely receive" : "Cannot receive"}
        </span>
      </div>
      <div className="an-card-grid">
        <Stat label="Max send" value={satLabel(data.maxSendEstimateSat)} />
        <Stat label="Max receive" value={satLabel(data.maxReceiveEstimateSat)} />
        <Stat label="Active channels" value={data.activeChannelCount} />
        <Stat label="Outbound" value={satLabel(data.outboundLiquiditySat)} />
        <Stat label="Inbound" value={satLabel(data.inboundLiquiditySat)} />
        <Stat label="Inactive channels" value={data.inactiveChannelCount} />
      </div>
      <Notes reasons={data.reasons} warnings={data.warnings} />
    </section>
  );
}

// ── on-chain reserve ──────────────────────────────────────────────────────────────

function OnchainSafety({ data }: { data: OnchainSafetyStatus }) {
  const tone = data.severity === "critical" ? "cost" : data.severity === "warning" ? "" : "green";
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>On-chain reserve</h2>
        <SeverityBadge severity={data.severity} />
      </div>
      <div className="an-card-grid">
        <Stat label="Confirmed" value={satLabel(data.confirmedBalanceSat)} tone={tone} />
        <Stat label="Unconfirmed" value={satLabel(data.unconfirmedBalanceSat)} />
        <Stat label="Recommended reserve" value={satLabel(data.recommendedReserveSat)} />
        <Stat label="Reserve ratio" value={pct(data.reserveRatio)} tone={tone} />
        {data.feeRateSatPerVbyte !== undefined ? (
          <Stat label="Fee rate" value={`${data.feeRateSatPerVbyte} sat/vB`} />
        ) : null}
        {data.estimatedForceCloseCostSat !== undefined ? (
          <Stat label="Est. force-close cost" value={satLabel(data.estimatedForceCloseCostSat)} />
        ) : null}
      </div>
      <Notes reasons={data.reasons} warnings={data.warnings} />
    </section>
  );
}

// ── liquidity safety ──────────────────────────────────────────────────────────────

function LiquiditySafety({ data }: { data: LiquiditySafetyStatus }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Liquidity safety</h2>
        {data.nodeNeed ? (
          <span className="sug-badge">{data.nodeNeed.replace(/_/g, " ")}</span>
        ) : (
          <SeverityBadge severity={data.severity} />
        )}
      </div>
      <div className="an-card-grid">
        <Stat label="Inbound" value={pct(data.inboundRatio)} />
        <Stat label="Outbound" value={pct(data.outboundRatio)} />
        <Stat label="Inbound sat" value={satLabel(data.inboundSat)} />
        <Stat label="Outbound sat" value={satLabel(data.outboundSat)} />
      </div>
      <div className={`sec-cat-bar sev-bar-${data.severity}`}>
        <i style={{ width: `${Math.min(100, Math.max(0, data.outboundRatio * 100))}%` }} />
      </div>
      <Notes reasons={data.reasons} warnings={data.warnings} />
    </section>
  );
}

// ── channel risk table ──────────────────────────────────────────────────────────

const RISK_LABEL: Record<ChannelRiskType, string> = {
  inactive: "Inactive",
  disabled: "Disabled",
  pending_htlc: "Stuck HTLC",
  pending_close: "Closing",
  force_close: "Force close",
  dead_capital: "Dead capital",
  negative_pnl: "Negative P&L",
  close_candidate: "Close candidate",
};

function ChannelRiskTable({ data }: { data: ChannelRiskStatus }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channel risk</h2>
        <SeverityBadge severity={data.severity} />
      </div>
      <div className="sec-counts">
        <span>Active: {data.activeChannelCount}</span>
        <span>Inactive: {data.inactiveChannelCount}</span>
        {data.pendingOpenCount ? <span>Pending open: {data.pendingOpenCount}</span> : null}
        {data.pendingCloseCount ? <span>Pending close: {data.pendingCloseCount}</span> : null}
        {data.forceCloseCount ? <span className="sec-warn">Force close: {data.forceCloseCount}</span> : null}
      </div>

      {data.riskyChannels.length === 0 ? (
        <p className="muted">No risky channels detected.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="fee-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Capacity</th>
                <th className="num">Local</th>
                <th>Risk</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.riskyChannels.map((ch) => (
                <tr key={ch.channelId}>
                  <td className="sec-mono">{ch.alias ?? ch.channelId}</td>
                  <td className="num">{satLabel(ch.capacitySat)}</td>
                  <td className="num">{pct(ch.localRatio)}</td>
                  <td>
                    <div className="sec-risk-tags">
                      {ch.riskTypes.map((rt) => (
                        <span key={rt} className={`sec-risk-tag sev-${ch.riskLevel}`}>
                          {RISK_LABEL[rt]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="muted">{ch.reasons[0] ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── main panel ──────────────────────────────────────────────────────────────────

export function SecurityPanel() {
  const [data, setData] = useState<SecuritySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const json = await api.securitySummary();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the security summary.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !data) return <SkeletonPanel rows={8} />;

  if (error && !data) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Security</h2>
        </div>
        <p className="sec-err">Could not load the security summary: {error}</p>
        <div className="sec-actions">
          <button type="button" className="sec-btn" onClick={load}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (!data) return null;

  return (
    <div className="sec-root">
      <div className="dryrun-banner">
        <strong>Read-only node-safety check.</strong> LightningMate inspects your node with read-only LND
        calls only — it never moves funds or changes channels here. Auto-refreshes every minute.
        <button type="button" className="sec-link" onClick={load} disabled={refreshing}>
          {refreshing ? " refreshing…" : " refresh now"}
        </button>
      </div>

      {!data.dataAvailability.lndReachable ? (
        <div className="banner error">
          LND unreachable — node safety cannot be verified.
          {data.dataAvailability.connectionError ? (
            <div className="banner-sub">{data.dataAvailability.connectionError}</div>
          ) : null}
        </div>
      ) : null}

      <ScoreCard data={data} />
      <CategoryGrid data={data} />

      {data.issues.length > 0 ? <Issues issues={data.issues} /> : null}
      <Recommendations recs={data.recommendations} />

      <BackupPanel data={data.backupHealth} onExported={load} />
      <PaymentReadiness data={data.paymentReadiness} />
      <OnchainSafety data={data.onchainSafety} />
      <LiquiditySafety data={data.liquiditySafety} />
      <ChannelRiskTable data={data.channelRisk} />
    </div>
  );
}

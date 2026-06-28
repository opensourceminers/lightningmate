import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BackupStatus } from "../types";

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Compact "Backup & Recovery" card: shows the channel backup (SCB) watchdog
 * status and a one-click export. Read-only except the operator-triggered export.
 */
export function BackupCard() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.backupStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.backupExport();
      setMessage("Backup downloaded. Store it encrypted, off this device.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stale = status?.stale ?? true;

  return (
    <section className="panel">
      <div className="panel-head"><h2>Backup &amp; Recovery</h2></div>

      <h3 className="sub">Channel backup (SCB)</h3>
      <div className="dryrun-banner">
        The static channel backup (SCB) lets you recover your channel funds if you lose this
        node. Re-export it whenever your channels change — it never contains your seed phrase.
      </div>

      {status ? (
        <>
          <div className="backup-status">
            <span className={`backup-dot ${stale ? "warn" : "ok"}`} />
            <span className={stale ? "backup-warn" : "earned"}>{status.reason}</span>
          </div>
          <p className="muted backup-meta">
            Last export: {formatWhen(status.lastExportAt)}
            {status.lastExportChannelCount !== null
              ? ` · ${status.lastExportChannelCount} channel(s)`
              : ""}
            {" · "}now {status.currentChannelCount} channel(s)
          </p>
        </>
      ) : (
        !error && <p className="muted">Checking backup status…</p>
      )}

      <div className="amboss-row">
        <button className="primary-btn" disabled={busy} onClick={() => void handleExport()}>
          {busy ? "Exporting…" : "Download backup"}
        </button>
      </div>

      {message ? <p className="earned backup-meta">{message}</p> : null}
      {error ? <p className="banner error">{error}</p> : null}
    </section>
  );
}

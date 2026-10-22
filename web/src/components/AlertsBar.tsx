import { useState } from "react";
import { api } from "../api";
import { usePolledData } from "../usePolledData";

/**
 * Node alerts come and go with the node's state. Alerts with an `id` (a damaged
 * state file, a service-fee problem) stay until the operator dismisses them —
 * they report something that already happened and must not go unnoticed.
 */
export function AlertsBar() {
  // Every 30 s while the page is visible (paused in a background tab).
  const polled = usePolledData(api.alerts, 30_000);
  const alerts = polled.data ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);

  const dismiss = async (id: string) => {
    setBusyId(id);
    try {
      await api.alertAck(id);
      polled.refresh();
    } catch {
      // keep it visible; the next poll retries the list
    } finally {
      setBusyId(null);
    }
  };

  if (alerts.length === 0) return null;

  return (
    <div className="alerts">
      {alerts.map((a, i) => (
        <span key={a.id ?? i} className={`alert ${a.level}`}>
          {a.level === "warn" ? "⚠" : "ℹ"} {a.message}
          {a.id ? (
            <button
              className="alert-dismiss"
              disabled={busyId === a.id}
              onClick={() => void dismiss(a.id as string)}
              title="I've seen this — dismiss"
            >
              Dismiss
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

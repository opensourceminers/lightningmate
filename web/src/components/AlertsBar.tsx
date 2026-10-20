import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Alert } from "../types";

/**
 * Node alerts come and go with the node's state. Alerts with an `id` (a damaged
 * state file, a service-fee problem) stay until the operator dismisses them —
 * they report something that already happened and must not go unnoticed.
 */
export function AlertsBar() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => api.alerts().then(setAlerts).catch(() => {}), []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => api.alerts().then((a) => !cancelled && setAlerts(a)).catch(() => {});
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const dismiss = async (id: string) => {
    setBusyId(id);
    try {
      await api.alertAck(id);
      await load();
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

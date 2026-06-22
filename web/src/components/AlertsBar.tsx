import { useEffect, useState } from "react";
import { api } from "../api";
import type { Alert } from "../types";

export function AlertsBar() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.alerts().then((a) => !cancelled && setAlerts(a)).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (alerts.length === 0) return null;

  return (
    <div className="alerts">
      {alerts.map((a, i) => (
        <span key={i} className={`alert ${a.level}`}>
          {a.level === "warn" ? "⚠" : "ℹ"} {a.message}
        </span>
      ))}
    </div>
  );
}

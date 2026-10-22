import { useEffect, useState } from "react";
import { api } from "./api";
import type { HealthInfo } from "./types";

// One /api/health request per page load, shared by every component that asks.
let pending: Promise<HealthInfo | null> | null = null;

/** The running server's /health answer (null until known). */
export function useHealthInfo(): HealthInfo | null {
  const [info, setInfo] = useState<HealthInfo | null>(null);
  useEffect(() => {
    let alive = true;
    pending ??= api.health().catch(() => {
      pending = null; // let a later mount try again
      return null;
    });
    void pending.then((h) => {
      if (alive) setInfo(h);
    });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** The running server's version string (empty until known). */
export function useAppVersion(): string {
  return useHealthInfo()?.version ?? "";
}

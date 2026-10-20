import { useEffect, useState } from "react";
import { api } from "./api";

// One /api/health request per page load, shared by every component that asks.
let pending: Promise<string> | null = null;

/** The running server's version string (empty until known). */
export function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    pending ??= api
      .health()
      .then((h) => h.version)
      .catch(() => {
        pending = null; // let a later mount try again
        return "";
      });
    void pending.then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

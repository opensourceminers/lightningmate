import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api";
import { Login } from "./Login";

type Phase = "checking" | "needsLogin" | "ready";

/**
 * Gates the whole app behind a session. On Umbrel a login is required (the
 * per-install app password); standalone (127.0.0.1) is open. An expired or
 * invalid session anywhere bounces back to the login screen.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");

  const check = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setPhase(!s.authRequired || s.unlocked ? "ready" : "needsLogin");
    } catch {
      setPhase("needsLogin");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase("needsLogin"));
    return () => setUnauthorizedHandler(() => {});
  }, []);

  if (phase === "checking") return <div className="loading">Connecting…</div>;
  if (phase === "needsLogin") return <Login onSuccess={() => setPhase("ready")} />;
  return <>{children}</>;
}

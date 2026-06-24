import { useState } from "react";
import { api } from "../api";
import { BrandMark } from "./BrandMark";

/** Full-screen sign-in shown before the app loads when Umbrel auth is required. */
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(false);
    const ok = await api.login(pw);
    setBusy(false);
    if (ok) onSuccess();
    else {
      setErr(true);
      setPw("");
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark />
          Lightning Mate
        </div>
        <p className="login-msg">
          Enter the app password Umbrel shows you (app&apos;s ⋮ menu → Credentials).
        </p>
        <input
          type="password"
          className="unlock-input"
          autoFocus
          value={pw}
          placeholder="App password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {err ? <p className="unlock-err">Wrong password — try again.</p> : null}
        <button className="primary-btn login-btn" disabled={!pw || busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}

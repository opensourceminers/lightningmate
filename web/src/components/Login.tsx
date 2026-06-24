import { useEffect, useState } from "react";
import { api } from "../api";
import { BrandMark } from "./BrandMark";

type Mode = "node" | "password";

/** Full-screen sign-in shown before the app loads when Umbrel auth is required. */
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<Mode>("node");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Login with node
  const [challenge, setChallenge] = useState("");
  const [sig, setSig] = useState("");
  const [copied, setCopied] = useState(false);

  // App password (fallback)
  const [pw, setPw] = useState("");

  const loadChallenge = async () => {
    try {
      setChallenge((await api.authChallenge()).challenge);
    } catch {
      setChallenge("");
    }
  };

  useEffect(() => {
    if (mode === "node" && !challenge) void loadChallenge();
  }, [mode, challenge]);

  const nodeLogin = async () => {
    if (!sig.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await api.nodeLogin(challenge, sig.trim());
    setBusy(false);
    if (r.ok) onSuccess();
    else {
      setErr(r.error ?? "Login failed.");
      setSig("");
      void loadChallenge(); // a used/expired challenge can't be retried
    }
  };

  const pwLogin = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    const ok = await api.login(pw);
    setBusy(false);
    if (ok) onSuccess();
    else {
      setErr("Wrong password — try again.");
      setPw("");
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(challenge);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark />
          Lightning Mate
        </div>

        {mode === "node" ? (
          <>
            <p className="login-msg">
              Sign in with your node: sign this challenge and paste the signature.
            </p>
            <label className="login-label">Challenge</label>
            <div className="challenge-row">
              <code className="challenge">{challenge || "…"}</code>
              <button className="reset" onClick={copy} disabled={!challenge}>
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <p className="login-hint">
              On your node: <code>lncli signmessage &lt;challenge&gt;</code> (or any node sign tool).
            </p>
            <textarea
              className="unlock-input sig-input"
              rows={3}
              value={sig}
              placeholder="Paste the signature"
              onChange={(e) => setSig(e.target.value)}
            />
            {err ? <p className="unlock-err">{err}</p> : null}
            <button
              className="primary-btn login-btn"
              disabled={!sig.trim() || busy}
              onClick={() => void nodeLogin()}
            >
              {busy ? "Verifying…" : "Sign in with node"}
            </button>
            <button className="link-btn" onClick={() => { setErr(null); setMode("password"); }}>
              Use app password instead
            </button>
          </>
        ) : (
          <>
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
                if (e.key === "Enter") void pwLogin();
              }}
            />
            {err ? <p className="unlock-err">{err}</p> : null}
            <button className="primary-btn login-btn" disabled={!pw || busy} onClick={() => void pwLogin()}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button className="link-btn" onClick={() => { setErr(null); setMode("node"); }}>
              Sign in with node instead
            </button>
          </>
        )}
      </div>
    </div>
  );
}

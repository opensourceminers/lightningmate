import { useState } from "react";
import { COPY_FAILED, copyText } from "../clipboard";
import { api } from "../api";
import { useUi } from "./Overlay";

/** What signing needs, said before anyone clicks (review 2026-11-10, SET-3). */
export const SIGN_NEEDS_WRITE = "Signing here needs write mode (the admin macaroon), which this install doesn't have.";
/** …and how else. */
export const SIGN_ELSEWHERE = "Sign the message on the node itself and paste that signature at Amboss:";

/**
 * Sign a message with the node's key — Amboss's "Login with Node" challenge,
 * or any other. Paste, sign, copy the signature back. In read-only mode it
 * says so up front instead of failing after the click (SET-3). Used in the
 * Amboss card's first step and as Settings' own section.
 */
export function SignMessage({ canWrite, placeholder, label = "Message to sign" }: { canWrite: boolean | null; placeholder?: string; label?: string }) {
  const ui = useUi();
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sign = async () => {
    if (!message.trim() || signing || canWrite === false) return;
    setSigning(true);
    setError(null);
    setSignature("");
    try {
      setSignature((await api.signMessage(message.trim())).signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  const copy = async () => {
    if (!(await copyText(signature))) {
      ui.toast(COPY_FAILED, "error");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (canWrite === false) {
    return (
      <p className="muted sign-readonly">
        {SIGN_NEEDS_WRITE} {SIGN_ELSEWHERE} <code>lncli signmessage "&lt;the message&gt;"</code>
      </p>
    );
  }
  return (
    <>
      <textarea
        className="unlock-input sig-input"
        rows={2}
        value={message}
        placeholder={placeholder ?? "Message to sign"}
        aria-label={label}
        onChange={(e) => {
          setMessage(e.target.value);
          setSignature("");
        }}
      />
      <div className="amboss-row">
        <button className="primary-btn" disabled={!message.trim() || signing} onClick={() => void sign()}>
          {signing ? "Signing…" : "Sign with node"}
        </button>
      </div>
      {signature ? (
        <div className="challenge-row" style={{ marginTop: 10 }}>
          <code className="challenge">{signature}</code>
          <button className="reset" onClick={() => void copy()}>
            {copied ? "copied" : "Copy"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

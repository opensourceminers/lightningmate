import { useState } from "react";

const DONATE = "bc1qje7dm783p86qu4xlvam6yrvy5mzx7qx76w72k8";
const GITHUB = "https://github.com/othervice/lightningmate";
const X_URL = "https://x.com/opensourceminers";
const SITE = "https://opensourceminers.de";

export function Footer() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(DONATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <footer className="foot">
      <div className="foot-links">
        <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
        <a href={X_URL} target="_blank" rel="noreferrer">X</a>
        <a href={SITE} target="_blank" rel="noreferrer">opensourceminers.de</a>
        <a href={`bitcoin:${DONATE}`} className="donate-link">⚡ Donate</a>
      </div>

      <div className="foot-donate">
        <span className="muted">Donate BTC</span>
        <code>{DONATE}</code>
        <button className="row-btn ghost" onClick={copy}>{copied ? "copied" : "copy"}</button>
      </div>

      <div className="foot-copy muted">
        © {new Date().getFullYear()} opensourceminers.de · MIT License · LightningMate
      </div>
    </footer>
  );
}

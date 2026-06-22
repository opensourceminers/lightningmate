import { useState } from "react";

const DONATE = "bc1qje7dm783p86qu4xlvam6yrvy5mzx7qx76w72k8";
const GITHUB = "https://github.com/opensourceminers/lightningmate";
const X_URL = "https://x.com/opensource_de";
const SITE = "https://opensourceminers.de";

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

export function Footer() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(DONATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <footer className="foot">
      <div className="foot-pills">
        <a className="foot-pill" href={GITHUB} target="_blank" rel="noreferrer">
          <GithubIcon /> GitHub
        </a>
        <a className="foot-pill" href={X_URL} target="_blank" rel="noreferrer">
          <XIcon /> @opensource_de
        </a>
        <a className="foot-pill" href={SITE} target="_blank" rel="noreferrer">
          <GlobeIcon /> opensourceminers.de
        </a>
        <a className="foot-pill donate" href={`bitcoin:${DONATE}`}>
          <BoltIcon /> Donate
        </a>
      </div>

      <div className="foot-donate">
        <BoltIcon />
        <code>{DONATE}</code>
        <button className="foot-copy-btn" onClick={copy}>{copied ? "✓ copied" : "copy"}</button>
      </div>

      <div className="foot-copy muted">
        © {new Date().getFullYear()} opensourceminers.de · MIT License · LightningMate
      </div>
    </footer>
  );
}

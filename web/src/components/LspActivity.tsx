import type { LspStatus } from "../types";
import { lspBlockedLine, lspRefusalLines, lspServedLine } from "../lspView";
import { timeAgo } from "../format";

/**
 * What LSP mode is doing, as the Settings card shows it while the mode is on:
 * listening or not, and the requests answered; why new orders are turned away,
 * whether or not the listener runs (a write macaroon without peers:read still
 * reads peer messages — it runs); the service's own error while it isn't
 * listening; and what wallets were refused, with the reason they were sent.
 */
export function LspActivity({ lsp }: { lsp: Pick<LspStatus, "running" | "blocked" | "lastError" | "lastRequestAt" | "requests"> }) {
  const blocked = lspBlockedLine(lsp);
  return (
    <>
      <div className="amboss-row" style={{ marginTop: 10 }}>
        <span className={`conn ${lsp.running ? "up" : "down"}`}>
          <i /> {lsp.running ? "Listening for LSP clients" : "Not listening"}
        </span>
        <span className="muted">
          Requests answered: {lspServedLine(lsp)}
          {lsp.lastRequestAt ? ` · last request ${timeAgo(lsp.lastRequestAt)}` : ""}
        </span>
      </div>
      {blocked ? <p className="banner error">{blocked}</p> : null}
      {!lsp.running && lsp.lastError ? <p className="banner error">{lsp.lastError}</p> : null}
      {lspRefusalLines(lsp).map((line) => (
        <p key={line} className="banner error">Refused — {line}</p>
      ))}
    </>
  );
}

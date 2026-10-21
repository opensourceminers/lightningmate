import type { AmbossKeyCheck } from "../types";

/**
 * The stored Amboss key's state, with the action that fits it.
 *
 * Three different situations, three different answers. Before, every failure
 * — a timeout, an outage, a real refusal — read "expired or revoked", and the
 * one button offered ("Reconnect") deleted the working key.
 *  - unreachable: Amboss didn't answer. Nothing is wrong with the key; offer
 *    "Re-check", never removal.
 *  - rejected: Amboss refused the key. "Re-check", and removal as a separate,
 *    explicit choice ("Remove key") to connect a fresh one.
 *  - fine: connected (and, once checked, valid).
 * Removal is always confirmed by the caller; with Magma orders in flight the
 * card says so up front (they can't be fulfilled without a key).
 */
export function AmbossKeyStatus(props: {
  keyValid: boolean | null | undefined;
  keyCheck: AmbossKeyCheck;
  lastError: string | null;
  busy: boolean;
  onRecheck: () => void;
  onRemove: () => void;
  /** Magma orders this node has taken on and not finished. */
  ordersInFlight?: number;
}) {
  const { keyValid, keyCheck, lastError, busy, onRecheck, onRemove, ordersInFlight = 0 } = props;
  // Next to a button that removes the key (none is offered while Amboss is
  // merely unreachable).
  const inFlight =
    ordersInFlight > 0 && keyCheck !== "unreachable" ? (
      <p className="sug-warn">
        ⚠ {ordersInFlight === 1 ? "1 Magma order is" : `${ordersInFlight} Magma orders are`} in flight. Removing the
        key stops LightningMate from opening, reporting and settling {ordersInFlight === 1 ? "it" : "them"} — it would
        only release held payments back to the buyers before they expire.
      </p>
    ) : null;
  return (
    <>
      <KeyState
        keyValid={keyValid}
        keyCheck={keyCheck}
        lastError={lastError}
        busy={busy}
        onRecheck={onRecheck}
        onRemove={onRemove}
      />
      {inFlight}
    </>
  );
}

function KeyState(props: {
  keyValid: boolean | null | undefined;
  keyCheck: AmbossKeyCheck;
  lastError: string | null;
  busy: boolean;
  onRecheck: () => void;
  onRemove: () => void;
}) {
  const { keyValid, keyCheck, lastError, busy, onRecheck, onRemove } = props;
  if (keyCheck === "unreachable") {
    return (
      <>
        <div className="amboss-row">
          <span className="conn">
            <i /> Amboss unreachable — retrying{keyValid === true ? " (your key was valid at the last check)" : ""}
          </span>
          <button className="reset" disabled={busy} onClick={onRecheck}>
            {busy ? "…" : "Re-check"}
          </button>
        </div>
        <p className="muted">
          Amboss didn't answer{lastError ? ` (${lastError})` : ""}. That says nothing about your key, which stays
          connected — buying and selling resume as soon as Amboss answers again.
        </p>
      </>
    );
  }
  if (keyValid === false) {
    return (
      <>
        <div className="amboss-row">
          <span className="conn down">
            <i /> Amboss rejected your key
          </span>
          <button className="reset" disabled={busy} onClick={onRecheck}>
            {busy ? "…" : "Re-check"}
          </button>
          <button className="reset" disabled={busy} onClick={onRemove}>
            Remove key
          </button>
        </div>
        <p className="banner error">
          Amboss refuses your stored key (expired or revoked), so buying and <strong>selling on Magma do
          nothing</strong> — no offers are managed and no orders are fulfilled. Get a fresh key at{" "}
          <a href="https://account.amboss.tech/settings/api-keys" target="_blank" rel="noreferrer">
            account.amboss.tech
          </a>
          , remove the old one here and connect the new one.
        </p>
      </>
    );
  }
  return (
    <div className="amboss-row">
      <span className="conn up">
        <i /> Amboss connected{keyValid === true ? " · key valid" : ""}
      </span>
      <button className="reset" disabled={busy} onClick={onRemove}>
        {busy ? "…" : "Disconnect"}
      </button>
    </div>
  );
}

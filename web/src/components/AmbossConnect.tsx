import { useEffect, useState } from "react";
import { api } from "../api";
import type { AmbossKeyCheck } from "../types";
import { removeKeyMessage } from "../statusNotes";
import { AmbossKeyStatus } from "./AmbossKeyStatus";
import { SignMessage } from "./SignMessage";
import { useUi } from "./Overlay";

/** Where Amboss's keys are made (and where it asks you to log in). */
export const AMBOSS_KEYS_URL = "https://account.amboss.tech/settings/api-keys";

/** What the card shows, for Settings: `ready` once the key's state is read
 *  (the page's height settles — a link to a section below scrolls then);
 *  `steps` while the steps, with their own signing box, are open. */
export interface AmbossCardState {
  ready: boolean;
  steps: boolean;
}

/**
 * Connecting Amboss, as one card with its steps in order (review 2026-11-10,
 * SET-2 — othervice, 2026-11-11: entering the key and signing for the
 * Amboss login were hidden): 1. log in at Amboss with the node — the message
 * box, "Sign with node" and the signature to copy sit right here; 2. make a
 * key there; 3. paste it, Connect, checked by Amboss. With a key stored: its
 * state, Re-check and Remove. A key Amboss rejected — also when Amboss can't
 * be reached at this moment — can be replaced here by a fresh one at once
 * (the connect replaces the stored key once Amboss takes the new one). A
 * state that can't be read is said as that, never as "no key".
 */
export function AmbossConnect({ canWrite, onState }: { canWrite: boolean | null; onState?: (s: AmbossCardState) => void }) {
  const ui = useUi();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyValid, setKeyValid] = useState<boolean | null | undefined>(undefined);
  const [keyCheck, setKeyCheck] = useState<AmbossKeyCheck>("unknown");
  const [lastError, setLastError] = useState<string | null>(null);
  const [ordersInFlight, setOrdersInFlight] = useState(0);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    api
      .ambossStatus()
      .then((s) => {
        setConnected(s.connected);
        setKeyValid(s.keyValid);
        setKeyCheck(s.keyCheck);
        setLastError(s.lastError);
        setOrdersInFlight(s.ordersInFlight ?? 0);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  // "Re-check": ask Amboss about the stored key now. Never deletes it.
  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.ambossKeyCheck();
      setKeyValid(s.keyValid);
      setKeyCheck(s.keyCheck);
      setLastError(s.lastError);
      setOrdersInFlight(s.ordersInFlight ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!keyInput.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.ambossConnect(keyInput.trim());
      setConnected(true);
      setKeyValid(true);
      setKeyCheck("valid");
      setLastError(null);
      setKeyInput("");
      ui.toast("Amboss connected — your key works.", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Removing the key is never a single click: it is confirmed, and the
  // confirmation says what happens to Magma orders still in flight (fetched
  // fresh — the count on screen may be minutes old).
  const remove = async () => {
    let inFlight = ordersInFlight;
    try {
      inFlight = (await api.ambossStatus()).ordersInFlight ?? inFlight;
      setOrdersInFlight(inFlight);
    } catch {
      // keep the last known count
    }
    const ok = await ui.confirm({
      title: inFlight > 0 ? "Remove the Amboss key? Orders are in flight" : "Remove the Amboss key?",
      message: removeKeyMessage(inFlight),
      confirmLabel: "Remove key",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.ambossDisconnect();
      setConnected(false);
      setKeyValid(undefined);
      setKeyCheck("unknown");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Rejected at the last check, whatever Amboss answers right now (review of
  // P10, F3: a check that failed this moment hid the way to a fresh key).
  const rejected = connected === true && keyValid === false;
  const steps = connected === false || rejected;
  const ready = connected !== null || loadError !== null;
  useEffect(() => {
    onState?.({ ready, steps });
  }, [ready, steps]);

  if (loadError !== null && connected === null) {
    return (
      <div className="amboss-connect">
        <p className="banner error" role="alert">
          Couldn&apos;t read your Amboss key&apos;s state ({loadError}).{" "}
          <button className="linklike" onClick={load}>
            Try again
          </button>
        </p>
      </div>
    );
  }
  if (connected === null) return <p className="muted">Checking…</p>;
  return (
    <div className="amboss-connect">
      {connected ? (
        <AmbossKeyStatus
          keyValid={keyValid}
          keyCheck={keyCheck}
          lastError={lastError}
          busy={busy}
          onRecheck={() => void recheck()}
          onRemove={() => void remove()}
          ordersInFlight={ordersInFlight}
        />
      ) : (
        <p className="muted">
          Buying and selling channels on Magma (Market tab) need your Amboss key. Three steps, all here; the key is stored
          only on your node.
        </p>
      )}
      {steps ? (
        <ol className="connect-steps">
          <li>
            <strong>Log in at Amboss with your node.</strong>{" "}
            <span className="muted">
              Open{" "}
              <a href={AMBOSS_KEYS_URL} target="_blank" rel="noreferrer">
                account.amboss.tech → Settings → API keys
              </a>
              ; when Amboss asks you to log in, choose your Lightning node. It shows a message (it starts with{" "}
              <code>amboss-</code>)
              {canWrite === false ? ": sign it on the node and paste the signature back at Amboss." : ": paste it here, sign it, and paste the signature back at Amboss."}{" "}
              Already logged in? Go on to step 2.
            </span>
            <SignMessage canWrite={canWrite} label="Amboss's message to sign" placeholder="Paste Amboss's message here (amboss-…)" />
          </li>
          <li>
            <strong>Make a key there.</strong>{" "}
            <span className="muted">
              On that page create a key and copy it. If it offers an expiry, choose the longest: when the key expires, buying
              and selling stop until you connect a fresh one. LightningMate uses the key for Magma only — your offers, their
              orders and the channels you buy.
            </span>
          </li>
          <li>
            <strong>{rejected ? "Paste the fresh key here." : "Paste the key here."}</strong>{" "}
            <span className="muted">
              Amboss checks it before anything is saved{rejected ? "; it replaces the rejected one" : ""}
              {keyCheck === "unreachable" ? " — Amboss can't be reached right now, so a fresh key is taken once it answers" : ""}.
            </span>
            <div className="amboss-row">
              <input
                type="password"
                className="unlock-input amboss-key"
                value={keyInput}
                placeholder="Amboss key"
                aria-label="Amboss key"
                autoComplete="off"
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void connect();
                }}
              />
              <button className="primary-btn" disabled={!keyInput.trim() || busy} onClick={() => void connect()}>
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </li>
        </ol>
      ) : null}
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

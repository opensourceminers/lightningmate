import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { api } from "../api";

type ToastType = "success" | "error" | "info";
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ConfirmOpts {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface UiApi {
  toast: (message: string, type?: ToastType) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  /** Prompt for the Umbrel password to unlock write mode. Resolves true on success. */
  unlock: () => Promise<boolean>;
}

const Ctx = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useUi must be used within <OverlayProvider>");
  return c;
}

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  const idRef = useRef(0);

  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => dismiss(id), 4500);
  }, []);

  const [unlockReq, setUnlockReq] = useState<{ resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })),
    [],
  );

  const unlock = useCallback(
    () => new Promise<boolean>((resolve) => setUnlockReq({ resolve })),
    [],
  );

  const settle = (result: boolean) => {
    pending?.resolve(result);
    setPending(null);
  };

  const settleUnlock = (result: boolean) => {
    unlockReq?.resolve(result);
    setUnlockReq(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm, unlock }}>
      {children}

      <div className="toast-viewport">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => dismiss(t.id)} role="status">
            <span className="toast-icon">{t.type === "success" ? "✓" : t.type === "error" ? "✕" : "ⓘ"}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {pending ? (
        <div className="modal-overlay" onClick={() => settle(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            {pending.opts.title ? <h3 className="modal-title">{pending.opts.title}</h3> : null}
            <p className="modal-msg">{pending.opts.message}</p>
            <div className="modal-actions">
              <button className="reset" onClick={() => settle(false)}>Cancel</button>
              <button
                className={`primary-btn ${pending.opts.danger ? "btn-danger" : ""}`}
                onClick={() => settle(true)}
              >
                {pending.opts.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {unlockReq ? <UnlockModal onDone={settleUnlock} /> : null}
    </Ctx.Provider>
  );
}

function UnlockModal({ onDone }: { onDone: (ok: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(false);
    const ok = await api.unlock(pw);
    setBusy(false);
    if (ok) onDone(true);
    else {
      setErr(true);
      setPw("");
    }
  };

  return (
    <div className="modal-overlay" onClick={() => onDone(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="modal-title">🔓 Unlock write mode</h3>
        <p className="modal-msg">
          Enter your <strong>Umbrel password</strong> to allow fee changes, rebalances, payments
          and autopilot for this session. The dashboard stays read-only until you do.
        </p>
        <input
          type="password"
          className="unlock-input"
          autoFocus
          value={pw}
          placeholder="Umbrel password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {err ? <p className="unlock-err">Wrong password — try again.</p> : null}
        <div className="modal-actions">
          <button className="reset" onClick={() => onDone(false)}>Cancel</button>
          <button className="primary-btn" disabled={!pw || busy} onClick={() => void submit()}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

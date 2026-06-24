import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

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

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ opts, resolve })),
    [],
  );

  const settle = (result: boolean) => {
    pending?.resolve(result);
    setPending(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
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
    </Ctx.Provider>
  );
}

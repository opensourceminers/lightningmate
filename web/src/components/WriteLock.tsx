import { useCallback, useEffect, useState } from "react";
import { api, setUnlockHandler } from "../api";
import { useUi } from "./Overlay";

/**
 * Topbar write-mode indicator. Only appears on Umbrel (where auth is required).
 * Reads are always live; writes need a session unlock with the Umbrel password.
 */
export function WriteLock() {
  const ui = useUi();
  const [required, setRequired] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setRequired(s.authRequired);
      setUnlocked(s.unlocked);
    } catch {
      // best-effort — leave indicator hidden if status can't be read
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Let a locked write anywhere trigger the prompt and sync our state.
  useEffect(() => {
    setUnlockHandler(async () => {
      const ok = await ui.unlock();
      if (ok) setUnlocked(true);
      return ok;
    });
    return () => setUnlockHandler(() => Promise.resolve(false));
  }, [ui]);

  if (!required) return null;

  if (unlocked) {
    return (
      <button
        className="writelock unlocked"
        title="Write mode is unlocked for this session. Click to lock again."
        onClick={() => {
          api.lock();
          setUnlocked(false);
        }}
      >
        🔓 write mode
      </button>
    );
  }

  return (
    <button
      className="writelock locked"
      title="Reads are live. Unlock with your Umbrel password to make changes."
      onClick={async () => {
        if (await ui.unlock()) setUnlocked(true);
      }}
    >
      🔒 unlock
    </button>
  );
}

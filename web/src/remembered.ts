import { useCallback, useState } from "react";

/**
 * Small per-browser conveniences: a section left open, the table columns
 * someone chose. Nothing the app depends on: storage that is blocked or full
 * just means the default next time.
 */
const PREFIX = "lm_ui_";

export function readRemembered(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeRemembered(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Not remembered: it still works for now.
  }
}

/** A yes/no that stays as it was left, in this browser. */
export function useRememberedFlag(key: string, fallback = false): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readRemembered(key);
    return stored === null ? fallback : stored === "1";
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeRemembered(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set];
}

/** The chosen items of a list, in this browser: only ids still in `allowed`. */
export function readRememberedList<T extends string>(key: string, allowed: readonly T[], fallback: readonly T[] = []): T[] {
  const stored = readRemembered(key);
  if (stored === null) return [...fallback];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [...fallback];
    return allowed.filter((id) => parsed.includes(id));
  } catch {
    return [...fallback];
  }
}

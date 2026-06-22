import { useCallback, useEffect, useRef, useState } from "react";

export interface PolledData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Fetch `fn` on mount and every `intervalMs`, exposing loading/error state. */
export function usePolledData<T>(
  fn: () => Promise<T>,
  intervalMs = 15_000,
): PolledData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the latest fn without re-subscribing the interval each render.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(async () => {
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { data, error, loading, refresh: load };
}

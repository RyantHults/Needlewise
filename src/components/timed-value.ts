import { useCallback, useEffect, useRef, useState } from 'react';

/** A value that clears itself `ms` after it was last set, and when the component unmounts. */
export function useTimedValue<T>(ms: number): [T | null, (value: T) => void, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setValue(null);
  }, []);

  const set = useCallback((next: T) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setValue(next);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setValue(null);
    }, ms);
  }, [ms]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  return [value, set, clear];
}

import { useEffect, useMemo, useRef } from 'react';

export interface LatestRequest {
  /** Starts a new request, superseding earlier ones, and returns its still-current check. */
  begin(): () => boolean;
  /** A still-current check for the latest request, without superseding it. */
  current(): () => boolean;
  /** Supersedes every request in flight. */
  cancel(): void;
}

/** Tracks the newest async request so stale and post-unmount results can be ignored. */
export function useLatestRequest(): LatestRequest {
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    // StrictMode tears effects down and replays them; the component is live again here.
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  return useMemo(() => {
    const check = (snapshot: number) => () => mounted.current && generation.current === snapshot;
    return {
      begin() {
        generation.current += 1;
        return check(generation.current);
      },
      current: () => check(generation.current),
      cancel() {
        generation.current += 1;
      }
    };
  }, []);
}

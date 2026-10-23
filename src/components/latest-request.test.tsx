import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { useLatestRequest } from './latest-request';

describe('useLatestRequest', () => {
  it('supersedes earlier requests when a new one begins', () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current.begin();
    expect(first()).toBe(true);
    const second = result.current.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('snapshots the latest request without superseding it', () => {
    const { result } = renderHook(() => useLatestRequest());
    const started = result.current.begin();
    const snapshot = result.current.current();
    expect(started()).toBe(true);
    expect(snapshot()).toBe(true);
    result.current.cancel();
    expect(snapshot()).toBe(false);
  });

  it('is not current after unmount', () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    const isCurrent = result.current.begin();
    unmount();
    expect(isCurrent()).toBe(false);
  });

  it('stays usable after a StrictMode effect replay', () => {
    const { result } = renderHook(() => useLatestRequest(), { wrapper: StrictMode });
    expect(result.current.begin()()).toBe(true);
  });
});

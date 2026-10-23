import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimedValue } from './timed-value';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useTimedValue', () => {
  it('clears the value after the delay', () => {
    const { result } = renderHook(() => useTimedValue<string>(1000));
    act(() => result.current[1]('a'));
    expect(result.current[0]).toBe('a');
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current[0]).toBe('a');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current[0]).toBeNull();
  });

  it('restarts the timer when set again', () => {
    const { result } = renderHook(() => useTimedValue<string>(1000));
    act(() => result.current[1]('a'));
    act(() => { vi.advanceTimersByTime(800); });
    act(() => result.current[1]('b'));
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current[0]).toBe('b');
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current[0]).toBeNull();
  });

  it('clears immediately and cancels the pending timer', () => {
    const { result } = renderHook(() => useTimedValue<string>(1000));
    act(() => result.current[1]('a'));
    act(() => result.current[2]());
    expect(result.current[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the timer on unmount', () => {
    const { result, unmount } = renderHook(() => useTimedValue<string>(1000));
    act(() => result.current[1]('a'));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

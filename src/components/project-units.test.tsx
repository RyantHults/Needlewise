import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProjectUnits } from './project-units';

const workspaceOf = (units: string | undefined, update = vi.fn().mockResolvedValue(undefined)) =>
  ({ metadata: { id: 'p1', units }, updateActiveMetadata: update }) as never;

describe('useProjectUnits', () => {
  it('starts from the project units, metric when unset', () => {
    expect(renderHook(() => useProjectUnits(workspaceOf('imperial'))).result.current[0]).toBe('imperial');
    expect(renderHook(() => useProjectUnits(workspaceOf(undefined))).result.current[0]).toBe('metric');
  });

  it('shows a change at once and saves it', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProjectUnits(workspaceOf('metric', update)));

    await act(() => result.current[1]('imperial'));
    expect(result.current[0]).toBe('imperial');
    expect(update).toHaveBeenCalledWith({ units: 'imperial' });
  });

  it('does nothing when the units are unchanged', async () => {
    const update = vi.fn();
    const { result } = renderHook(() => useProjectUnits(workspaceOf('metric', update)));

    await act(() => result.current[1]('metric'));
    expect(update).not.toHaveBeenCalled();
  });

  it('rolls back when the save fails', async () => {
    const { result } = renderHook(() => useProjectUnits(workspaceOf('metric', vi.fn().mockRejectedValue(new Error('no')))));

    await act(() => result.current[1]('imperial'));
    expect(result.current[0]).toBe('metric');
  });

  it('does not let an older failed save undo a newer change', async () => {
    let failFirst: (error: Error) => void = () => undefined;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useProjectUnits(workspaceOf('metric', update)));

    let first: Promise<void> = Promise.resolve();
    act(() => { first = result.current[1]('imperial'); });
    await act(() => result.current[1]('metric'));
    await act(() => result.current[1]('imperial'));
    await act(async () => { failFirst(new Error('no')); await first; });

    expect(result.current[0]).toBe('imperial');
  });
});

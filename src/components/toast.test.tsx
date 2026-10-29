import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, TOAST_LONG_DURATION_MS, ToastProvider, usePinnedToast, useToast, type ToastInput } from './toast';

let show: (toast: ToastInput) => void;

function Harness({ pinned }: { pinned: ToastInput | null }) {
  show = useToast();
  usePinnedToast(pinned);
  return null;
}

function renderToasts(pinned: ToastInput | null = null) {
  const view = render(<ToastProvider><Harness pinned={pinned} /></ToastProvider>);
  return (next: ToastInput | null) => view.rerender(<ToastProvider><Harness pinned={next} /></ToastProvider>);
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides an info toast after the short duration', () => {
    renderToasts();
    act(() => show({ message: 'Pattern renamed.' }));

    expect(screen.getByText('Pattern renamed.')).toBeInTheDocument();
    advance(TOAST_DURATION_MS);
    expect(screen.queryByText('Pattern renamed.')).not.toBeInTheDocument();
  });

  it('keeps an error toast for the long duration and announces it as an alert', () => {
    renderToasts();
    act(() => show({ message: 'Could not save.', tone: 'error' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
    advance(TOAST_DURATION_MS);
    expect(screen.getByText('Could not save.')).toBeInTheDocument();
    advance(TOAST_LONG_DURATION_MS - TOAST_DURATION_MS);
    expect(screen.queryByText('Could not save.')).not.toBeInTheDocument();
  });

  it('replaces the showing toast with a new one', () => {
    renderToasts();
    act(() => show({ message: 'First' }));
    act(() => show({ message: 'Second' }));

    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('runs a toast action and dismisses the toast', () => {
    renderToasts();
    const run = vi.fn();
    act(() => show({ message: 'Moved.', action: { label: 'Undo', run } }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Moved.')).not.toBeInTheDocument();
  });

  it('keeps a pinned toast until its input becomes null', () => {
    const rerender = renderToasts({ message: 'Update ready.' });

    advance(TOAST_LONG_DURATION_MS * 2);
    expect(screen.getByText('Update ready.')).toBeInTheDocument();
    rerender(null);
    expect(screen.queryByText('Update ready.')).not.toBeInTheDocument();
  });
});

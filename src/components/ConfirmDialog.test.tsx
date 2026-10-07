import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConfirmDialog title="Delete Ruby?" message="This cannot be undone." confirmLabel="Delete color" onConfirm={onConfirm} onCancel={onCancel} {...overrides} />);
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('focuses Cancel first', () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('describes the dialog with the message', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Delete Ruby?' })).toHaveAccessibleDescription('This cannot be undone.');
  });

  it('calls onConfirm from the confirm button only', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Delete color' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel from Cancel, Escape and the backdrop', () => {
    const { onConfirm, onCancel } = renderDialog({ cancelLabel: 'Keep' });

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);

    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('has no close button', () => {
    renderDialog();

    expect(screen.queryByText('×')).not.toBeInTheDocument();
  });
});

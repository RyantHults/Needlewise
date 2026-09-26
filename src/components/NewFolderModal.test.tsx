import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewFolderModal } from './NewFolderModal';

function renderModal(overrides: Partial<Parameters<typeof NewFolderModal>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const props = { parentName: null, onSubmit, onClose, ...overrides };
  const view = render(<NewFolderModal {...props} />);
  return { onSubmit, onClose, ...view };
}

describe('NewFolderModal', () => {
  it('portals a labelled dialog to the document body', () => {
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'Name your folder' });
    expect(dialog.closest('body')).toBe(document.body);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('titles the dialog with the parent folder name when nested', () => {
    renderModal({ parentName: 'Holiday cards' });

    expect(screen.getByRole('heading', { name: 'New folder in Holiday cards' })).toBeInTheDocument();
  });

  it('autofocuses the folder name input and caps it at MAX_FOLDER_NAME_CHARS', () => {
    renderModal();

    const input = screen.getByLabelText('Folder name');
    expect(document.activeElement).toBe(input);
    expect(input).toHaveAttribute('maxlength', '80');
  });

  it('disables Create folder until a non-blank name is entered', () => {
    renderModal();
    const submit = screen.getByRole('button', { name: 'Create folder' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Crafts' } });
    expect(submit).toBeEnabled();
  });

  it('submits the trimmed name', () => {
    const { onSubmit } = renderModal();
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: '  Crafts  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));

    expect(onSubmit).toHaveBeenCalledWith('Crafts');
  });

  it('closes on Escape, the close button, and a backdrop click, but not a click inside the dialog', () => {
    const { onClose, rerender } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<NewFolderModal parentName={null} onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<NewFolderModal parentName={null} onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close new folder dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus between the close button and the submit button', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Crafts' } });
    const close = screen.getByRole('button', { name: 'Close new folder dialog' });
    const submit = screen.getByRole('button', { name: 'Create folder' });

    submit.focus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });

  it('inerts the rest of the application while open and restores focus to the trigger on close', () => {
    const shell = document.createElement('div');
    shell.dataset.application = '';
    document.body.append(shell);
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = renderModal();
    expect(shell).toHaveProperty('inert', true);

    unmount();
    expect(shell).toHaveProperty('inert', false);
    expect(document.activeElement).toBe(trigger);

    shell.remove();
    trigger.remove();
  });
});

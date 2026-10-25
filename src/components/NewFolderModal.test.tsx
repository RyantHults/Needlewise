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

});

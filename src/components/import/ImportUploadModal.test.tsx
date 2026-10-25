import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternImporter } from '../../import/types';
import { dropData } from '../test-support';

const registry = vi.hoisted(() => ({ findImporter: vi.fn(), importerAccept: () => '.pdf,application/pdf' }));
vi.mock('../../import/registry', () => registry);

const { ImportUploadModal } = await import('./ImportUploadModal');

beforeEach(() => {
  registry.findImporter.mockReset();
  registry.findImporter.mockImplementation((head: Uint8Array) => (new TextDecoder().decode(head).includes('%PDF-') ? ({ id: 'pdf' } as PatternImporter) : undefined));
});

describe('ImportUploadModal', () => {
  it('explains what can be imported and offers the importer types', () => {
    render(<ImportUploadModal onClose={vi.fn()} onFile={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Import a pattern' });
    expect(dialog).toHaveAccessibleDescription('Upload a pattern to import it into Needlewise. We currently support importing from PDFs.');
    expect(screen.getByLabelText('Choose a pattern file to import')).toHaveAttribute('accept', '.pdf,application/pdf');
  });

  it('sniffs only the leading bytes and hands over a supported file', async () => {
    const onFile = vi.fn();
    render(<ImportUploadModal onClose={vi.fn()} onFile={onFile} />);
    const file = new File([`%PDF-1.7\n${'x'.repeat(5000)}`], 'garden.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose a pattern file to import'), { target: { files: [file] } });
    await waitFor(() => expect(onFile).toHaveBeenCalledWith(file));
    expect((registry.findImporter.mock.calls[0] as [Uint8Array])[0].length).toBe(1024);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the modal open with an inline error for an unsupported drop, then accepts a PDF', async () => {
    const onFile = vi.fn();
    render(<ImportUploadModal onClose={vi.fn()} onFile={onFile} />);
    const zone = screen.getByLabelText('Choose a pattern file to import').closest('label') as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: dropData(new File(['hello'], 'notes.txt', { type: 'text/plain' })) });
    expect(await screen.findByRole('alert')).toHaveTextContent('This file is not a pattern Needlewise can import. Choose a PDF pattern.');
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Import a pattern' })).toBeInTheDocument();

    const pdf = new File(['%PDF-1.4'], 'chart.pdf');
    fireEvent.drop(zone, { dataTransfer: dropData(pdf) });
    await waitFor(() => expect(onFile).toHaveBeenCalledWith(pdf));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes directly on Escape and on the close button', () => {
    const onClose = vi.fn();
    render(<ImportUploadModal onClose={onClose} onFile={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close import dialog' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

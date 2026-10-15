import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileDropZone } from './FileDropZone';

function dropData(...files: File[]) {
  return { files: Object.assign([...files], { item: (index: number) => files[index] ?? null }), types: files.length ? ['Files'] : [], dropEffect: 'none' };
}

const base = { id: 'zone', accept: '.pdf', inputLabel: 'Choose a file', title: 'Drop a file here', hint: 'PDF only' };

describe('FileDropZone', () => {
  it('hands over a browsed file and clears the input so the same file can be chosen again', () => {
    const onFile = vi.fn();
    render(<FileDropZone {...base} onFile={onFile} />);
    const input = screen.getByLabelText('Choose a file');
    expect(input).toHaveAttribute('accept', '.pdf');
    const file = new File(['%PDF-'], 'chart.pdf');
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.change(input, { target: { files: [] } });
    expect(onFile).toHaveBeenCalledOnce();
  });

  it('shows the drag state and hands over a dropped file', () => {
    const onFile = vi.fn();
    render(<FileDropZone {...base} onFile={onFile} />);
    const zone = screen.getByLabelText('Choose a file').closest('label') as HTMLElement;
    expect(zone).toHaveTextContent('Drop a file here');
    expect(zone).toHaveTextContent('PDF only');
    expect(zone).toHaveTextContent('Browse files');
    const over = fireEvent.dragOver(zone, { dataTransfer: dropData() });
    expect(over).toBe(false);
    expect(zone).toHaveClass('file-drop-active');
    fireEvent.dragLeave(zone, { dataTransfer: dropData() });
    expect(zone).not.toHaveClass('file-drop-active');
    fireEvent.dragEnter(zone, { dataTransfer: dropData() });
    const file = new File(['%PDF-'], 'dropped.pdf');
    fireEvent.drop(zone, { dataTransfer: dropData(file) });
    expect(zone).not.toHaveClass('file-drop-active');
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('shows the selected file with its replace labels', () => {
    render(<FileDropZone {...base} file={new File(['x'], 'picked.pdf')} selectedHint="Drop another to replace it" replaceLabel="Replace file" onFile={vi.fn()} />);
    const zone = screen.getByLabelText('Choose a file').closest('label') as HTMLElement;
    expect(zone).toHaveClass('file-drop-selected');
    expect(zone).toHaveTextContent('picked.pdf');
    expect(zone).toHaveTextContent('Drop another to replace it');
    expect(zone).toHaveTextContent('Replace file');
    expect(zone).not.toHaveTextContent('Drop a file here');
  });

  it('refuses drags and drops while disabled', () => {
    const onFile = vi.fn();
    render(<FileDropZone {...base} disabled onFile={onFile} />);
    expect(screen.getByLabelText('Choose a file')).toBeDisabled();
    const zone = screen.getByLabelText('Choose a file').closest('label') as HTMLElement;
    const data = dropData();
    fireEvent.dragOver(zone, { dataTransfer: data });
    expect(data.dropEffect).toBe('none');
    expect(zone).not.toHaveClass('file-drop-active');
    fireEvent.drop(zone, { dataTransfer: dropData(new File(['x'], 'x.pdf')) });
    expect(onFile).not.toHaveBeenCalled();
  });
});

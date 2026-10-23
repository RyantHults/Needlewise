import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInlineEdit } from './inline-edit';

function Harness({ value, onCommit }: { value: string; onCommit: (next: string) => void | Promise<void> }) {
  const edit = useInlineEdit(value, onCommit);
  return edit.editing
    ? <input aria-label="name" {...edit.inputProps} />
    : <button ref={edit.triggerRef} type="button" onClick={edit.start}>{value}</button>;
}

function open() {
  fireEvent.click(screen.getByRole('button'));
  return screen.getByLabelText('name') as HTMLInputElement;
}

describe('useInlineEdit', () => {
  it('focuses and selects the input on start', () => {
    render(<Harness value="Rose" onCommit={() => undefined} />);
    const input = open();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
  });

  it('commits the trimmed text on Enter once, and returns focus to the trigger', () => {
    const onCommit = vi.fn();
    render(<Harness value="Rose" onCommit={onCommit} />);
    const input = open();
    fireEvent.change(input, { target: { value: '  Tulip  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Tulip');
    expect(document.activeElement).toBe(screen.getByRole('button'));
  });

  it('commits on blur without moving focus', () => {
    const onCommit = vi.fn();
    render(<Harness value="Rose" onCommit={onCommit} />);
    const input = open();
    fireEvent.change(input, { target: { value: 'Tulip' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('Tulip');
    expect(document.activeElement).not.toBe(screen.getByRole('button'));
  });

  it('cancels on Escape and returns focus to the trigger', () => {
    const onCommit = vi.fn();
    render(<Harness value="Rose" onCommit={onCommit} />);
    const input = open();
    fireEvent.change(input, { target: { value: 'Tulip' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button').textContent).toBe('Rose');
    expect(document.activeElement).toBe(screen.getByRole('button'));
  });

  it('skips empty and unchanged text', () => {
    const onCommit = vi.fn();
    render(<Harness value="Rose" onCommit={onCommit} />);
    let input = open();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    input = open();
    fireEvent.change(input, { target: { value: ' Rose ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, type ModalProps } from './Modal';

function renderModal(overrides: Partial<ModalProps> = {}, children: React.ReactNode = <button type="button">Inside</button>) {
  const onClose = vi.fn();
  const view = render(<Modal title="Hello" onClose={onClose} {...overrides}>{children}</Modal>);
  return { onClose, ...view };
}

function flushFocusReturn() {
  act(() => { vi.runAllTimers(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div data-application id="app"><button id="trigger" type="button">Open</button></div>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Modal', () => {
  it('portals a labelled dialog and backdrop to the body', () => {
    renderModal({ eyebrow: 'Eyebrow', className: 'extra' });

    const dialog = screen.getByRole('dialog', { name: 'Hello' });
    expect(dialog.parentElement).toHaveClass('modal-backdrop');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('create-modal', 'extra');
    expect(screen.getByText('Eyebrow')).toHaveClass('section-label');
  });

  it('wires describedBy and a custom titleId', () => {
    renderModal({ titleId: 'my-title', describedBy: 'my-desc' });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'my-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'my-desc');
    expect(document.getElementById('my-title')).toHaveTextContent('Hello');
  });

  it('inerts the application and restores it on unmount', () => {
    const app = document.getElementById('app') as HTMLElement;
    const { unmount } = renderModal();

    expect(app.inert).toBe(true);
    unmount();
    expect(app.inert).toBe(false);
  });

  it('restores inert in LIFO order for stacked modals', () => {
    const app = document.getElementById('app') as HTMLElement;
    const first = renderModal({ title: 'First' });
    const second = render(<Modal title="Second" onClose={() => {}}><button type="button">Two</button></Modal>);

    second.unmount();
    expect(app.inert).toBe(true);
    first.unmount();
    expect(app.inert).toBe(false);
  });

  describe('initial focus', () => {
    it('defaults to the first focusable control', () => {
      renderModal({}, <><button type="button" disabled>Off</button><button type="button">On</button></>);

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On' }));
    });

    it('falls back to the dialog when nothing is focusable', () => {
      renderModal({}, <p>Text</p>);

      expect(document.activeElement).toBe(screen.getByRole('dialog'));
    });

    it('accepts a selector', () => {
      renderModal({ initialFocus: '#second' }, <><button type="button">First</button><button id="second" type="button">Second</button></>);

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second' }));
    });

    it('accepts a ref', () => {
      const ref = createRef<HTMLInputElement>();
      renderModal({ initialFocus: ref }, <><button type="button">First</button><input ref={ref} aria-label="Field" /></>);

      expect(document.activeElement).toBe(ref.current);
    });
  });

  describe('Tab trap', () => {
    const controls = (
      <>
        <button type="button">A</button>
        <button type="button" disabled>Disabled</button>
        <button type="button" tabIndex={-1}>Skipped</button>
        <div hidden><button type="button">Hidden</button></div>
        <button type="button">B</button>
      </>
    );

    it('wraps forward from the last control, skipping unavailable ones', () => {
      renderModal({}, controls);
      const dialog = screen.getByRole('dialog');
      screen.getByRole('button', { name: 'B' }).focus();

      fireEvent.keyDown(dialog, { key: 'Tab' });

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'A' }));
    });

    it('wraps backward from the first control', () => {
      renderModal({}, controls);
      const dialog = screen.getByRole('dialog');
      screen.getByRole('button', { name: 'A' }).focus();

      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });

      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'B' }));
    });

    it('lets Tab move normally in the middle', () => {
      renderModal({ closeLabel: 'Close' }, controls);
      const dialog = screen.getByRole('dialog');
      screen.getByRole('button', { name: 'A' }).focus();

      expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true);
    });
  });

  describe('Escape', () => {
    it('calls onClose', () => {
      const { onClose } = renderModal();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onEscape instead of onClose when given', () => {
      const onEscape = vi.fn();
      const { onClose } = renderModal({ onEscape });

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('uses the latest onEscape closure', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderModal({ onEscape: first });

      rerender(<Modal title="Hello" onClose={() => {}} onEscape={second}><button type="button">Inside</button></Modal>);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('reacts only in the topmost of two stacked modals', () => {
      const outerClose = vi.fn();
      const innerClose = vi.fn();
      render(
        <>
          <Modal title="Outer" onClose={outerClose}><button type="button">Outer button</button></Modal>
          <Modal title="Inner" onClose={innerClose}><button type="button">Inner button</button></Modal>
        </>
      );

      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Inner' }), { key: 'Escape' });

      expect(innerClose).toHaveBeenCalledTimes(1);
      expect(outerClose).not.toHaveBeenCalled();
    });
  });

  describe('closing', () => {
    it('closes on a backdrop click but not a click inside', () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
      fireEvent.click(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores the backdrop when closeOnBackdrop is false', () => {
      const { onClose } = renderModal({ closeOnBackdrop: false });

      fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('renders the × only with closeLabel, and it closes', () => {
      const { onClose, unmount } = renderModal();
      expect(screen.queryByText('×')).not.toBeInTheDocument();
      unmount();

      const view = renderModal({ closeLabel: 'Close dialog' });
      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

      expect(view.onClose).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('disables the × with closeDisabled', () => {
      renderModal({ closeLabel: 'Close dialog', closeDisabled: true });

      expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    });
  });

  it('keeps focus in the dialog when StrictMode remounts it', () => {
    render(<StrictMode><Modal title="Hello" onClose={() => {}}><button type="button">Inside</button></Modal></StrictMode>);

    flushFocusReturn();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
  });

  describe('focus return', () => {
    function Harness({ returnFocus }: { returnFocus?: ModalProps['returnFocus'] }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button id="open" type="button" onClick={() => setOpen(true)}>Open it</button>
          <button id="other" type="button">Other</button>
          {open ? <Modal title="Hello" returnFocus={returnFocus} onClose={() => setOpen(false)}><button type="button">Inside</button></Modal> : null}
        </>
      );
    }

    function openAndClose(returnFocus?: ModalProps['returnFocus']) {
      render(<Harness returnFocus={returnFocus} />);
      const opener = screen.getByRole('button', { name: 'Open it' });
      opener.focus();
      fireEvent.click(opener);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      flushFocusReturn();
      return opener;
    }

    it('returns to the element focused at mount by default', () => {
      const opener = openAndClose();

      expect(document.activeElement).toBe(opener);
    });

    it('returns to a given ref', () => {
      const target = document.createElement('button');
      document.body.append(target);
      const ref = { current: target };
      const { unmount } = render(<Modal title="Hello" returnFocus={ref} onClose={() => {}}><button type="button">Inside</button></Modal>);

      unmount();
      flushFocusReturn();

      expect(document.activeElement).toBe(target);
    });

    it('leaves focus alone when returnFocus is false', () => {
      const opener = openAndClose(false);

      expect(document.activeElement).not.toBe(opener);
    });
  });
});

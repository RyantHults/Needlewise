import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  /** Backdrop click, the × button, and Escape (unless `onEscape` is given). */
  onClose: () => void;
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  titleId?: string;
  describedBy?: string;
  /** Appended to `create-modal` on the dialog element. */
  className?: string;
  /** When set, renders the × button with this accessible name. */
  closeLabel?: string;
  closeDisabled?: boolean;
  closeOnBackdrop?: boolean;
  /** Overrides Escape, e.g. to close an inner panel before the modal. */
  onEscape?: () => void;
  /** A selector inside the dialog, or a ref. Defaults to the first focusable control, then the dialog. */
  initialFocus?: string | React.RefObject<HTMLElement | null>;
  /** Defaults to the element focused when the modal mounted; `false` leaves focus to the caller. */
  returnFocus?: React.RefObject<HTMLElement | null> | false;
  dialogRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = 'button,input,select,textarea,a[href],[tabindex]';

function focusableWithin(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (item) => !item.hasAttribute('disabled') && item.tabIndex >= 0 && !item.closest('[hidden]')
  );
}

export function Modal({
  onClose,
  title,
  eyebrow,
  titleId,
  describedBy,
  className,
  closeLabel,
  closeDisabled = false,
  closeOnBackdrop = true,
  onEscape,
  initialFocus,
  returnFocus,
  dialogRef,
  children
}: ModalProps) {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onEscapeRef = useRef(onEscape);
  const initialFocusRef = useRef(initialFocus);
  const returnFocusRef = useRef(returnFocus);
  onCloseRef.current = onClose;
  onEscapeRef.current = onEscape;
  initialFocusRef.current = initialFocus;
  returnFocusRef.current = returnFocus;

  const setDialogElement = useCallback((node: HTMLDivElement | null) => {
    elementRef.current = node;
    if (typeof dialogRef === 'function') dialogRef(node);
    else if (dialogRef) dialogRef.current = node;
  }, [dialogRef]);

  // Inerts the rest of the app, moves focus in, traps Tab, and handles Escape. Nested
  // modals unmount in LIFO order, so each restores the inert value it found.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.querySelector<HTMLElement>('[data-application]');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const el = elementRef.current;

    const requested = initialFocusRef.current;
    const target = typeof requested === 'string' ? el?.querySelector<HTMLElement>(requested) : requested?.current;
    (target ?? (el ? focusableWithin(el)[0] : null) ?? el)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        (onEscapeRef.current ?? onCloseRef.current)();
        return;
      }
      if (event.key !== 'Tab' || !el) return;
      const focusable = focusableWithin(el);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) { event.preventDefault(); el.focus(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === el)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    el?.addEventListener('keydown', handleKeyDown);

    return () => {
      el?.removeEventListener('keydown', handleKeyDown);
      if (root) root.inert = wasInert;
      const returnTo = returnFocusRef.current;
      if (returnTo === false) return;
      const restoreTarget = returnTo ? returnTo.current : previousFocus;
      // StrictMode re-runs this effect; don't pull focus out of a modal that is still open.
      window.setTimeout(() => {
        if (document.activeElement?.closest('[aria-modal="true"]')) return;
        if (restoreTarget?.isConnected) restoreTarget.focus();
      }, 0);
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}>
      <div
        ref={setDialogElement}
        className={className ? `create-modal ${className}` : 'create-modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {closeLabel ? <button className="modal-close" type="button" aria-label={closeLabel} disabled={closeDisabled} onClick={onClose}>×</button> : null}
        {eyebrow ? <p className="section-label">{eyebrow}</p> : null}
        <h2 id={headingId}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
}

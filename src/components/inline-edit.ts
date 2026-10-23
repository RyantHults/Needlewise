import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';

export interface InlineEdit {
  editing: boolean;
  start: () => void;
  /** Attach to the control that starts editing; it regains focus after Enter or Escape. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  inputProps: {
    ref: RefObject<HTMLInputElement | null>;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
}

/**
 * Rename-in-place state. Enter or blur commits the trimmed text unless it is empty or
 * unchanged, and Escape cancels. The result is settled once, so the blur that follows
 * Enter or Escape cannot fire a second time.
 */
export function useInlineEdit(value: string, onCommit: (next: string) => void | Promise<unknown>): InlineEdit {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settledRef = useRef(false);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useLayoutEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  function start() {
    settledRef.current = false;
    setDraft(value);
    setEditing(true);
  }

  function commit(fromKeyboard: boolean) {
    if (settledRef.current) return;
    settledRef.current = true;
    restoreFocusRef.current = fromKeyboard;
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== value) void onCommit(trimmed);
  }

  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    restoreFocusRef.current = true;
    setDraft(value);
    setEditing(false);
  }

  return {
    editing,
    start,
    triggerRef,
    inputProps: {
      ref: inputRef,
      value: draft,
      onChange: (event) => setDraft(event.target.value),
      onBlur: () => commit(false),
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(true); }
        else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }
    }
  };
}

import { useEffect, useRef, type RefObject } from "react";

export interface DismissableOptions {
  open: boolean;
  /** Elements that count as the overlay's inside, such as the menu and its trigger. */
  refs: readonly RefObject<Element | null>[];
  /** Called on Escape when this overlay is the topmost, and on a press outside it. */
  onDismiss: () => void;
  /** Focused synchronously after Escape dismisses the overlay. An outside press never moves focus. */
  returnFocus?: RefObject<HTMLElement | null> | HTMLElement | null;
}

type Entry = { current: DismissableOptions };

// Open overlays, topmost last. Modals register here too, so an overlay opened inside one sits above it.
const stack: Entry[] = [];

function contains(entry: Entry, target: Node) {
  return entry.current.refs.some((ref) => ref.current?.contains(target));
}

// Window capture, so Escape reaches only the topmost overlay and never the editor's window handler.
function handleKeyDown(event: KeyboardEvent) {
  const top = stack.at(-1);
  if (event.key !== "Escape" || !top) return;
  event.preventDefault();
  event.stopPropagation();
  const { onDismiss, returnFocus } = top.current;
  onDismiss();
  (returnFocus instanceof HTMLElement ? returnFocus : returnFocus?.current)?.focus();
}

// A press inside an overlay is inside every overlay beneath it, so a portaled nested menu keeps its parent open.
function handlePointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  const outside: Entry[] = [];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (contains(stack[index], target)) break;
    outside.push(stack[index]);
  }
  for (const entry of outside) entry.current.onDismiss();
}

/** Registers an open overlay on the shared stack: Escape dismisses the topmost one, and an outside press dismisses each one it missed. */
export function useDismissable(options: DismissableOptions) {
  const entry = useRef(options);
  entry.current = options;
  const { open } = options;

  useEffect(() => {
    if (!open) return undefined;
    stack.push(entry);
    if (stack.length === 1) {
      window.addEventListener("keydown", handleKeyDown, true);
      document.addEventListener("pointerdown", handlePointerDown, true);
    }
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length > 0) return;
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [open]);
}

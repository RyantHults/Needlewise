import { useCallback, useEffect, useRef, useState } from "react";

export const TOAST_DURATION_MS = 3200;

export interface ToastMessage {
  /** Increments per show, so repeating the same text restarts the timer. */
  id: number;
  message: string;
}

/** Holds the one toast the editor shows at a time. */
export function useToast(): { toast: ToastMessage | null; showToast: (message: string) => void; dismissToast: () => void } {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const next = useRef(0);
  const showToast = useCallback((message: string) => {
    next.current += 1;
    setToast({ id: next.current, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  return { toast, showToast, dismissToast };
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
  duration?: number;
}

/**
 * A brief, non-blocking notice. The live region stays mounted so screen
 * readers announce each new message; the visible card disappears on its own.
 */
export function Toast({ toast, onDismiss, duration = TOAST_DURATION_MS }: Props) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [toast, duration, onDismiss]);
  return (
    <div className="editor-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && <p key={toast.id} className="editor-toast">{toast.message}</p>}
    </div>
  );
}

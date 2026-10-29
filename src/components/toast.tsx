import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export const TOAST_DURATION_MS = 3200;
/** Errors and toasts with an action stay long enough to read and reach. */
export const TOAST_LONG_DURATION_MS = 6000;

export interface ToastInput {
  message: string;
  /** Omitted for an info toast. */
  tone?: "error";
  action?: { label: string; run: () => void };
}

interface ShownToast extends ToastInput {
  /** Increments per show, so repeating the same text restarts the timer. */
  id: number;
}

interface ToastContextValue {
  show: (toast: ToastInput) => void;
  pin: (key: string, toast: ToastInput | null) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function useToastContext(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("Toasts need a ToastProvider.");
  return context;
}

/** Shows one transient toast, replacing the one already showing. */
export function useToast(): (toast: ToastInput) => void {
  return useToastContext().show;
}

/** Keeps `toast` showing, with no timer, for as long as it is non-null. */
export function usePinnedToast(toast: ToastInput | null): void {
  const { pin } = useToastContext();
  const key = useId();
  const latest = useRef(toast);
  latest.current = toast;
  const run = useCallback(() => latest.current?.action?.run(), []);
  const message = toast?.message;
  const tone = toast?.tone;
  const label = toast?.action?.label;
  useEffect(() => {
    pin(key, message === undefined ? null : { message, tone, action: label === undefined ? undefined : { label, run } });
  }, [pin, key, message, tone, label, run]);
  useEffect(() => () => pin(key, null), [pin, key]);
}

function ToastCard({ toast, onAction }: { toast: ToastInput; onAction: () => void }) {
  return (
    <div className="toast" data-tone={toast.tone} role={toast.tone === "error" ? "alert" : undefined}>
      <span className="toast-message">{toast.message}</span>
      {toast.action && <button className="toast-action" type="button" onClick={onAction}>{toast.action.label}</button>}
    </div>
  );
}

/**
 * Owns the app's one toast region. The live region stays mounted so screen
 * readers announce each new message; transient cards disappear on their own.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const [pinned, setPinned] = useState<ReadonlyMap<string, ToastInput>>(new Map());
  const next = useRef(0);

  const show = useCallback((input: ToastInput) => {
    next.current += 1;
    setToast({ ...input, id: next.current });
  }, []);
  const pin = useCallback((key: string, input: ToastInput | null) => {
    setPinned((current) => {
      if (!input && !current.has(key)) return current;
      const updated = new Map(current);
      if (input) updated.set(key, input);
      else updated.delete(key);
      return updated;
    });
  }, []);
  const value = useMemo(() => ({ show, pin }), [show, pin]);

  useEffect(() => {
    if (!toast) return undefined;
    const duration = toast.tone === "error" || toast.action ? TOAST_LONG_DURATION_MS : TOAST_DURATION_MS;
    const timer = window.setTimeout(() => setToast(null), duration);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {[...pinned].map(([key, entry]) => <ToastCard key={key} toast={entry} onAction={() => entry.action?.run()} />)}
        {toast && <ToastCard key={toast.id} toast={toast} onAction={() => { setToast(null); toast.action?.run(); }} />}
      </div>
    </ToastContext.Provider>
  );
}

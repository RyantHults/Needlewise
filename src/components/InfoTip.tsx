import { useId, useLayoutEffect, useRef, useState } from "react";
import { useDismissable } from "./dismiss";

interface InfoTipProps {
  /** The button's accessible name, e.g. "Pencil mode information". */
  label: string;
  /** The tooltip element's id; generated when omitted. */
  id?: string;
  children: React.ReactNode;
}

const GAP_PX = 8;

/**
 * An "i" button with a tooltip. Hover and focus show it, a click or tap pins it
 * open or closes it, and Escape, an outside press or blur close it. The tip is
 * fixed-positioned so scroll containers such as a table frame cannot clip it.
 */
export function InfoTip({ label, id, children }: InfoTipProps) {
  const generatedId = useId();
  const tipId = id ?? generatedId;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [peek, setPeek] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const open = peek || pinned;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      const tipWidth = tipRef.current?.offsetWidth ?? 0;
      if (!button) return;
      const left = Math.max(GAP_PX, Math.min(button.left, window.innerWidth - tipWidth - GAP_PX));
      setPosition({ top: button.bottom + GAP_PX, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useDismissable({ open, refs: [wrapRef], onDismiss: () => { setPeek(false); setPinned(false); } });

  return (
    <span ref={wrapRef} className="settings-info-wrap" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>
      <button
        ref={buttonRef}
        className="settings-info-button"
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        aria-expanded={open}
        onFocus={() => setPeek(true)}
        onBlur={() => { setPeek(false); setPinned(false); }}
        onClick={() => {
          if (pinned) { setPinned(false); setPeek(false); } else setPinned(true);
        }}
      >
        i
      </button>
      <span
        ref={tipRef}
        id={tipId}
        className="settings-info-tooltip"
        role="tooltip"
        data-open={open}
        style={open && position ? { top: position.top, left: position.left } : undefined}
      >
        {children}
      </span>
    </span>
  );
}

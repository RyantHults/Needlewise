import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDismissable } from "../dismiss";

type DockPanel = "tools" | "colors" | null;

export interface MobileDock {
  panel: DockPanel;
  setPanel: (panel: DockPanel) => void;
  dockRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  toolsTriggerRef: RefObject<HTMLButtonElement | null>;
  colorsTriggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Open/close state for the phone-width Tools and Colors popovers: focus moves
 * into the open popover, Escape closes it and refocuses its trigger, and a
 * pointer press outside the dock and its triggers closes it. Overlays opened
 * above it, such as a modal or the palette menu, keep it open.
 */
export function useMobileDock(): MobileDock {
  const [panel, setPanel] = useState<DockPanel>(null);
  const dockRef = useRef<HTMLElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const colorsTriggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel) popoverRef.current?.focus();
  }, [panel]);
  useDismissable({
    open: panel !== null,
    refs: [dockRef, toolsTriggerRef, colorsTriggerRef],
    onDismiss: () => setPanel(null),
    returnFocus: panel === "tools" ? toolsTriggerRef : colorsTriggerRef,
  });
  return { panel, setPanel, dockRef, popoverRef, toolsTriggerRef, colorsTriggerRef };
}

const DOCK_LABELS = { tools: "Tools", colors: "Colors" } as const;

/** One dock panel's content: inline in the rail at desktop width, a dialog popover at phone width while open. */
export function DockPopover({ dock, panel, children }: { dock: MobileDock; panel: "tools" | "colors"; children: ReactNode }) {
  const open = dock.panel === panel;
  return (
    <div ref={open ? dock.popoverRef : undefined} id={`mobile-${panel}-popover`} className={`editor-rail-popover mobile-${panel}-popover${open ? " mobile-popover-open" : ""}`} role={open ? "dialog" : undefined} aria-label={DOCK_LABELS[panel]} tabIndex={-1}>
      {children}
    </div>
  );
}

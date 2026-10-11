import { useEffect, useRef, useState, type RefObject } from "react";

type DockPanel = "tools" | "colors" | null;

/**
 * Open/close state for the phone-width Tools and Colors popovers: focus moves
 * into the open popover, Escape closes it and refocuses its trigger, and a
 * pointer press outside the dock closes it unless `blocked` (a modal is open).
 */
export function useMobileDock({ blocked = false }: { blocked?: boolean } = {}): {
  panel: DockPanel;
  setPanel: (panel: DockPanel) => void;
  dockRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  toolsTriggerRef: RefObject<HTMLButtonElement | null>;
  colorsTriggerRef: RefObject<HTMLButtonElement | null>;
} {
  const [panel, setPanel] = useState<DockPanel>(null);
  const dockRef = useRef<HTMLElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const colorsTriggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panel) return;
    popoverRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanel(null);
        window.setTimeout(() => {
          (panel === "tools" ? toolsTriggerRef : colorsTriggerRef).current?.focus();
        }, 0);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (blocked) return;
      const target = event.target;
      if (target instanceof Node && !dockRef.current?.contains(target) && !(target instanceof Element && target.closest(".mobile-dock-trigger, .editor-rail-popover"))) setPanel(null);
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    globalThis.document.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      globalThis.document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [panel, blocked]);
  return { panel, setPanel, dockRef, popoverRef, toolsTriggerRef, colorsTriggerRef };
}

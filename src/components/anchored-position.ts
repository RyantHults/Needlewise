export type MenuPlacement = 'right' | 'above';

export interface MenuSize {
  width: number;
  height: number;
}

export interface AnchoredPosition {
  left: number;
  top: number;
  transform?: string;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
const ABOVE_GAP = 8;

function clamp(value: number, max: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(value, max));
}

/**
 * Fixed-position coordinates for a menu opened from `rect`, kept inside the viewport.
 * `right` sits beside the anchor's right edge; `above` is bottom-aligned above the
 * anchor's top edge, so its height is not needed (it translates itself up).
 */
export function anchoredPosition(
  rect: Pick<DOMRect, 'left' | 'right' | 'top'>,
  placement: MenuPlacement,
  size: MenuSize,
  viewport: MenuSize = { width: window.innerWidth, height: window.innerHeight }
): AnchoredPosition {
  if (placement === 'right') {
    return {
      left: clamp(rect.right + ANCHOR_GAP, viewport.width - size.width),
      top: clamp(rect.top, viewport.height - size.height)
    };
  }
  return {
    left: clamp(rect.left, viewport.width - size.width),
    top: Math.max(VIEWPORT_MARGIN, rect.top - ABOVE_GAP),
    transform: 'translateY(-100%)'
  };
}

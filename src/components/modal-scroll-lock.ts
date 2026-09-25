// iOS/iPadOS Safari ignores `overflow:hidden`/`overscroll-behavior` on html/body for touch
// scroll chaining: a single-finger drag starting on non-scrollable modal content still
// rubber-bands or scrolls the page behind it. The CSS lock at styles.css (`html:has(...)`)
// covers every other browser; this listener is the iOS-only fallback, active only while a
// modal is open, and it must be a non-passive touchmove handler so preventDefault() can win.

const MODAL_SELECTOR = '[aria-modal="true"]';
const MODAL_BOUNDARY_SELECTOR = '.modal-backdrop';

interface TouchPoint {
  x: number;
  y: number;
}

/** Whether `el` is a scrollable ancestor with room left to move in the drag's direction. */
function elementCanScrollTowardDelta(el: Element, axis: 'x' | 'y', delta: number): boolean {
  const overflow = axis === 'y' ? getComputedStyle(el).overflowY : getComputedStyle(el).overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  const offset = axis === 'y' ? el.scrollTop : el.scrollLeft;
  const extent = axis === 'y' ? el.clientHeight : el.clientWidth;
  const size = axis === 'y' ? el.scrollHeight : el.scrollWidth;
  // Finger moving down/right reveals earlier content, which needs existing scroll offset;
  // finger moving up/left needs room further down/right.
  return delta > 0 ? offset > 0 : offset + extent < size;
}

/** Walks target..boundary (inclusive) looking for an ancestor that can absorb the drag. */
function hasScrollableAncestor(target: Element, boundary: Element, axis: 'x' | 'y', delta: number): boolean {
  let node: Element | null = target;
  while (node) {
    if (elementCanScrollTowardDelta(node, axis, delta)) return true;
    if (node === boundary) return false;
    node = node.parentElement;
  }
  return false;
}

/**
 * Prevents iOS Safari from scrolling/rubber-banding the page or modal chrome behind an open
 * `[aria-modal="true"]` dialog, while still allowing pinch zoom, range-input drags, and drags
 * inside genuinely scrollable modal regions that have room left to move. Returns a cleanup
 * that removes the listeners.
 */
export function installModalScrollLock(doc: Document = document): () => void {
  let start: TouchPoint | null = null;

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return; // allow pinch zoom
    if (!doc.querySelector(MODAL_SELECTOR)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('input[type="range"]')) return; // native slider drag

    const touch = event.touches[0];
    const from = start ?? { x: touch.clientX, y: touch.clientY };
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (dx === 0 && dy === 0) return; // no direction to judge yet

    const boundary = target.closest(MODAL_BOUNDARY_SELECTOR);
    if (!boundary) {
      event.preventDefault(); // touch landed on the page behind the modal
      return;
    }

    const axis: 'x' | 'y' = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    const delta = axis === 'x' ? dx : dy;
    if (hasScrollableAncestor(target, boundary, axis, delta)) return;
    event.preventDefault();
  };

  doc.addEventListener('touchstart', onTouchStart, { passive: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: false });

  return () => {
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
  };
}

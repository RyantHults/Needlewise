import { afterEach, describe, expect, it } from 'vitest';
import { installModalScrollLock } from './modal-scroll-lock';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

function makeTouch(x: number, y: number) {
  return { clientX: x, clientY: y } as Touch;
}

function dispatchTouch(type: 'touchstart' | 'touchmove', target: EventTarget, touches: Touch[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'target', { value: target });
  target.dispatchEvent(event);
  return event;
}

function makeScrollable(overflowY: string, scrollTop: number, clientHeight: number, scrollHeight: number) {
  const el = document.createElement('div');
  el.style.overflowY = overflowY;
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  return el;
}

describe('installModalScrollLock', () => {
  it('does not prevent touch scrolling when no modal is open', () => {
    cleanup = installModalScrollLock(document);
    const target = document.createElement('div');
    document.body.appendChild(target);

    dispatchTouch('touchstart', target, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', target, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(false);
  });

  it('prevents dragging non-scrollable modal content', () => {
    cleanup = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const content = document.createElement('p');
    dialog.appendChild(content);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    dispatchTouch('touchstart', content, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', content, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(true);
  });

  it('does not prevent dragging inside a scrollable container with room left', () => {
    cleanup = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const scrollable = makeScrollable('auto', 20, 100, 400);
    dialog.appendChild(scrollable);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    // Dragging down (finger moves down) needs scrollTop > 0, which it has.
    dispatchTouch('touchstart', scrollable, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', scrollable, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(false);
  });

  it('prevents dragging past a scrollable container edge', () => {
    cleanup = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const scrollable = makeScrollable('auto', 0, 100, 400);
    dialog.appendChild(scrollable);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    // Dragging down at scrollTop 0 has no room to scroll further in that direction.
    dispatchTouch('touchstart', scrollable, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', scrollable, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(true);
  });

  it('does not prevent drags starting on a range input', () => {
    cleanup = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const range = document.createElement('input');
    range.type = 'range';
    dialog.appendChild(range);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    dispatchTouch('touchstart', range, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', range, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(false);
  });

  it('does not prevent two-finger touches (pinch zoom)', () => {
    cleanup = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    dispatchTouch('touchstart', dialog, [makeTouch(0, 0), makeTouch(10, 10)]);
    const move = dispatchTouch('touchmove', dialog, [makeTouch(0, 40), makeTouch(10, 50)]);

    expect(move.defaultPrevented).toBe(false);
  });

  it('prevents touches on the page behind the modal', () => {
    cleanup = installModalScrollLock(document);
    const page = document.createElement('div');
    document.body.appendChild(page);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    dispatchTouch('touchstart', page, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', page, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(true);
  });

  it('removes both listeners on cleanup', () => {
    const remove = installModalScrollLock(document);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const content = document.createElement('p');
    dialog.appendChild(content);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    remove();

    dispatchTouch('touchstart', content, [makeTouch(0, 0)]);
    const move = dispatchTouch('touchmove', content, [makeTouch(0, 40)]);

    expect(move.defaultPrevented).toBe(false);
  });
});

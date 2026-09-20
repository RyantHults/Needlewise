import { describe, expect, it, vi } from 'vitest';
import { createPointerEventsAdapter, type PointerEventSurface, type PointerSample } from './input';

class FakeSurface implements PointerEventSurface {
  readonly handlers = new Map<string, (event: Event) => void>();
  readonly captures: number[] = [];
  readonly releases: number[] = [];
  containedTarget: unknown;

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.handlers.delete(type);
  }

  setPointerCapture(pointerId: number): void {
    this.captures.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.releases.push(pointerId);
  }

  getBoundingClientRect(): { left: number; top: number } {
    return { left: 10, top: 20 };
  }

  contains(target: unknown): boolean {
    return target === this.containedTarget;
  }

  dispatch(type: string, event: Event): void {
    this.handlers.get(type)?.(event);
  }
}

function pointerEvent(pointerId: number, clientX: number, clientY: number): PointerEvent {
  return {
    pointerId,
    pointerType: 'pen',
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    isPrimary: true,
    preventDefault: () => undefined,
    getCoalescedEvents: () => []
  } as unknown as PointerEvent;
}

describe('DOM pointer event adapter', () => {
  it('translates coordinates, forwards coalesced samples, captures pointers, and cleans up', () => {
    const surface = new FakeSurface();
    const down: Array<{ x: number; y: number }> = [];
    const moves: Array<{ x: number; y: number }> = [];
    let cancels = 0;
    let lost = 0;
    let blurs = 0;
    const controller = {
      handlePointerDown: (sample: { screenX: number; screenY: number }) => { down.push({ x: sample.screenX, y: sample.screenY }); return true; },
      handlePointerMove: (sample: { screenX: number; screenY: number }) => { moves.push({ x: sample.screenX, y: sample.screenY }); return true; },
      handlePointerUp: () => true,
      handlePointerCancel: () => { cancels += 1; return true; },
      handlePointerLostCapture: () => { lost += 1; return true; },
      handleWheel: () => true,
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => { blurs += 1; }
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    surface.dispatch('pointerdown', pointerEvent(7, 15, 26));
    const first = pointerEvent(7, 16, 27);
    const second = pointerEvent(7, 18, 29);
    (first as unknown as { getCoalescedEvents: () => PointerEvent[] }).getCoalescedEvents = () => [first, second];
    surface.dispatch('pointermove', first);
    surface.dispatch('pointercancel', pointerEvent(7, 18, 29));
    surface.dispatch('lostpointercapture', pointerEvent(7, 18, 29));
    surface.dispatch('blur', new Event('blur'));
    expect(down).toEqual([{ x: 5, y: 6 }]);
    expect(moves).toEqual([{ x: 6, y: 7 }, { x: 8, y: 9 }]);
    expect(cancels).toBe(1);
    expect(lost).toBe(1);
    expect(blurs).toBe(1);
    expect(surface.captures).toEqual([7]);
    expect(surface.releases).toEqual([7]);
    expect(surface.handlers.size).toBe(10);
    adapter.dispose();
    expect(surface.handlers.size).toBe(0);
  });

  it('routes keyboard events to an optional separate surface without duplicating pointer bindings', () => {
    const pointerSurface = new FakeSurface();
    const keyboardSurface = new FakeSurface();
    const keyDowns: string[] = [];
    const keyUps: string[] = [];
    const controller = {
      handlePointerDown: () => true,
      handlePointerMove: () => true,
      handlePointerUp: () => true,
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => true,
      handleWheel: () => true,
      handleKeyDown: (sample: { key: string }) => { keyDowns.push(sample.key); return true; },
      handleKeyUp: (sample: { key: string }) => { keyUps.push(sample.key); return true; },
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(pointerSurface, controller, { keyboardSurface });

    expect(pointerSurface.handlers.has('keydown')).toBe(false);
    expect(pointerSurface.handlers.has('keyup')).toBe(false);
    expect(pointerSurface.handlers.size).toBe(8);
    expect(keyboardSurface.handlers.size).toBe(2);

    keyboardSurface.dispatch('keydown', new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    keyboardSurface.dispatch('keyup', new KeyboardEvent('keyup', { key: 'z' }));
    pointerSurface.dispatch('keydown', new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(keyDowns).toEqual(['z']);
    expect(keyUps).toEqual(['z']);

    adapter.dispose();
    expect(pointerSurface.handlers.size).toBe(0);
    expect(keyboardSurface.handlers.size).toBe(0);
  });

  it('keeps controller blur cleanup when focus leaves the editor but ignores contained focus transitions', () => {
    const surface = new FakeSurface();
    const child = {};
    surface.containedTarget = child;
    let blurs = 0;
    const controller = {
      handlePointerDown: () => true,
      handlePointerMove: () => true,
      handlePointerUp: () => true,
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => true,
      handleWheel: () => true,
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => { blurs += 1; }
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    const containedBlur = new Event('blur') as FocusEvent;
    Object.defineProperty(containedBlur, 'relatedTarget', { value: child });
    surface.dispatch('blur', containedBlur);
    expect(blurs).toBe(0);
    const settingsTarget = {};
    const externalBlur = new Event('blur') as FocusEvent;
    Object.defineProperty(externalBlur, 'relatedTarget', { value: settingsTarget });
    surface.dispatch('blur', externalBlur);
    expect(blurs).toBe(1);
    surface.dispatch('blur', new Event('blur'));
    expect(blurs).toBe(2);
    adapter.dispose();
  });

  it('excludes local interactive targets from pointer and keyboard controller routing', () => {
    const surface = new FakeSurface();
    const menuTarget = {};
    const calls = { down: 0, move: 0, up: 0, cancel: 0, lost: 0, keyDown: 0, keyUp: 0 };
    const controller = {
      handlePointerDown: () => { calls.down += 1; return true; },
      handlePointerMove: () => { calls.move += 1; return true; },
      handlePointerUp: () => { calls.up += 1; return true; },
      handlePointerCancel: () => { calls.cancel += 1; return true; },
      handlePointerLostCapture: () => { calls.lost += 1; return true; },
      handleWheel: () => true,
      handleKeyDown: () => { calls.keyDown += 1; return true; },
      handleKeyUp: () => { calls.keyUp += 1; return true; },
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(surface, controller, {
      shouldExcludeTarget: (target) => target === menuTarget
    });
    const withTarget = <T extends object>(event: T, target: unknown): T => {
      Object.defineProperty(event, 'target', { value: target });
      return event;
    };
    for (const [type, event] of [
      ['pointerdown', pointerEvent(1, 15, 26)],
      ['pointermove', pointerEvent(1, 16, 27)],
      ['pointerup', pointerEvent(1, 16, 27)],
      ['pointercancel', pointerEvent(1, 16, 27)],
      ['lostpointercapture', pointerEvent(1, 16, 27)]
    ] as const) surface.dispatch(type, withTarget(event, menuTarget) as unknown as Event);
    const keyboardEvent = (target: unknown): Event => withTarget({ key: 'Enter', preventDefault: () => undefined }, target) as unknown as Event;
    surface.dispatch('keydown', keyboardEvent(menuTarget));
    surface.dispatch('keyup', keyboardEvent(menuTarget));
    expect(calls).toEqual({ down: 0, move: 0, up: 0, cancel: 0, lost: 0, keyDown: 0, keyUp: 0 });

    surface.dispatch('pointerdown', withTarget(pointerEvent(2, 15, 26), {}) as unknown as Event);
    surface.dispatch('keydown', keyboardEvent({}));
    surface.dispatch('keyup', keyboardEvent({}));
    expect(calls.down).toBe(1);
    expect(calls.keyDown).toBe(1);
    expect(calls.keyUp).toBe(1);
    adapter.dispose();
  });

  it('delivers touch pointer sequences through the DOM surface with capture lifecycle intact', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const surface = document.createElement('div');
    const captures: number[] = [];
    const releases: number[] = [];
    const downs: PointerSample[] = [];
    const moves: PointerSample[] = [];
    const ups: PointerSample[] = [];
    let released = false;
    let lostAfterRelease = 0;
    surface.getBoundingClientRect = () => ({ left: 10, top: 20 } as DOMRect);
    Object.defineProperty(surface, 'setPointerCapture', { value: (id: number) => captures.push(id) });
    Object.defineProperty(surface, 'releasePointerCapture', { value: (id: number) => releases.push(id) });
    document.body.append(surface);
    const controller = {
      handlePointerDown: (sample: PointerSample) => { downs.push(sample); return true; },
      handlePointerMove: (sample: PointerSample) => { moves.push(sample); return true; },
      handlePointerUp: (sample: PointerSample) => { ups.push(sample); released = true; return true; },
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => { if (released) lostAfterRelease += 1; return true; },
      handleWheel: () => true,
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    const event = (type: string, clientX: number, clientY: number, timeStamp: number): PointerEvent => {
      const next = new Event(type, { cancelable: true });
      Object.defineProperties(next, {
        pointerId: { value: 11 },
        pointerType: { value: 'touch' },
        clientX: { value: clientX },
        clientY: { value: clientY },
        timeStamp: { value: timeStamp },
        button: { value: 0 },
        buttons: { value: type === 'pointerup' ? 0 : 1 },
        isPrimary: { value: true },
        getCoalescedEvents: { value: () => [] }
      });
      return next as PointerEvent;
    };

    surface.dispatchEvent(event('pointerdown', 15, 26, 100));
    surface.dispatchEvent(event('pointermove', 18, 29, 125));
    surface.dispatchEvent(event('pointerup', 20, 31, 150));
    surface.dispatchEvent(event('lostpointercapture', 20, 31, 175));
    adapter.dispose();
    surface.remove();

    expect(downs).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(downs[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 5, screenY: 6, timeStamp: 100 }));
    expect(moves[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 8, screenY: 9, timeStamp: 125 }));
    expect(ups[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 10, screenY: 11, timeStamp: 150 }));
    expect(lostAfterRelease).toBe(1);
    expect(captures).toEqual([11]);
    expect(releases).toEqual([11]);
    debug.mockRestore();
  });

  it('diagnoses touch transport lifecycle events without logging pointer moves', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const surface = new FakeSurface();
    const controller = {
      handlePointerDown: () => true,
      handlePointerMove: () => true,
      handlePointerUp: () => true,
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => true,
      handleWheel: () => true,
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    const touchEvent = (id: number, type: string, timeStamp: number): PointerEvent => ({
      ...pointerEvent(id, 15, 26),
      pointerType: 'touch',
      timeStamp
    } as unknown as PointerEvent);
    surface.dispatch('pointerdown', touchEvent(1, 'pointerdown', 10));
    surface.dispatch('pointerup', touchEvent(1, 'pointerup', 20));
    surface.dispatch('pointercancel', touchEvent(1, 'pointercancel', 30));
    surface.dispatch('lostpointercapture', touchEvent(1, 'lostpointercapture', 40));
    adapter.dispose();
    expect(debug.mock.calls.filter(([prefix]) => prefix === '[Needlewise touch]')).toHaveLength(4);
    expect(debug.mock.calls.map(([, eventName]) => eventName)).toEqual(['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']);
    expect(debug.mock.calls.every(([, , details]) => (details as { x: number; y: number; timeStamp: number; handled: boolean }).x === 5
      && (details as { y: number }).y === 6
      && (details as { timeStamp: number }).timeStamp >= 10
      && (details as { handled: boolean }).handled)).toBe(true);
    debug.mockRestore();
  });

  it('does not forward non-finite pointer or wheel samples', () => {
    const surface = new FakeSurface();
    let downs = 0;
    let moves = 0;
    let ups = 0;
    let wheels = 0;
    const controller = {
      handlePointerDown: () => { downs += 1; return true; },
      handlePointerMove: () => { moves += 1; return true; },
      handlePointerUp: () => { ups += 1; return true; },
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => true,
      handleWheel: () => { wheels += 1; return true; },
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    const invalidDown = pointerEvent(1, Number.NaN, 26);
    surface.dispatch('pointerdown', invalidDown);
    const invalidMove = pointerEvent(1, 15, Number.POSITIVE_INFINITY);
    surface.dispatch('pointermove', invalidMove);
    surface.dispatch('pointerup', invalidDown);
    surface.dispatch('wheel', { clientX: 15, clientY: 26, deltaY: Number.NaN } as unknown as WheelEvent);
    expect(downs).toBe(0);
    expect(moves).toBe(0);
    expect(ups).toBe(0);
    expect(wheels).toBe(0);
    adapter.dispose();
  });
});

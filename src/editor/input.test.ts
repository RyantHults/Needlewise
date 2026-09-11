import { describe, expect, it } from 'vitest';
import { createPointerEventsAdapter, type PointerEventSurface, type PointerSample } from './input';

class FakeSurface implements PointerEventSurface {
  readonly handlers = new Map<string, (event: Event) => void>();
  readonly captures: number[] = [];
  readonly releases: number[] = [];

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

  it('delivers touch pointer sequences through the DOM surface with capture lifecycle intact', () => {
    const surface = document.createElement('div');
    const captures: number[] = [];
    const releases: number[] = [];
    const downs: PointerSample[] = [];
    const moves: PointerSample[] = [];
    const ups: PointerSample[] = [];
    surface.getBoundingClientRect = () => ({ left: 10, top: 20 } as DOMRect);
    Object.defineProperty(surface, 'setPointerCapture', { value: (id: number) => captures.push(id) });
    Object.defineProperty(surface, 'releasePointerCapture', { value: (id: number) => releases.push(id) });
    document.body.append(surface);
    const controller = {
      handlePointerDown: (sample: PointerSample) => { downs.push(sample); return true; },
      handlePointerMove: (sample: PointerSample) => { moves.push(sample); return true; },
      handlePointerUp: (sample: PointerSample) => { ups.push(sample); return true; },
      handlePointerCancel: () => true,
      handlePointerLostCapture: () => true,
      handleWheel: () => true,
      handleKeyDown: () => true,
      handleKeyUp: () => true,
      handleBlur: () => undefined
    };
    const adapter = createPointerEventsAdapter(surface, controller);
    const event = (type: string, clientX: number, clientY: number): PointerEvent => {
      const next = new Event(type, { cancelable: true });
      Object.defineProperties(next, {
        pointerId: { value: 11 },
        pointerType: { value: 'touch' },
        clientX: { value: clientX },
        clientY: { value: clientY },
        button: { value: 0 },
        buttons: { value: type === 'pointerup' ? 0 : 1 },
        isPrimary: { value: true },
        getCoalescedEvents: { value: () => [] }
      });
      return next as PointerEvent;
    };

    surface.dispatchEvent(event('pointerdown', 15, 26));
    surface.dispatchEvent(event('pointermove', 18, 29));
    surface.dispatchEvent(event('pointerup', 20, 31));
    adapter.dispose();
    surface.remove();

    expect(downs).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(downs[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 5, screenY: 6 }));
    expect(moves[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 8, screenY: 9 }));
    expect(ups[0]).toEqual(expect.objectContaining({ pointerType: 'touch', screenX: 10, screenY: 11 }));
    expect(captures).toEqual([11]);
    expect(releases).toEqual([11]);
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

import { describe, expect, it } from 'vitest';
import { createPointerEventsAdapter, type PointerEventSurface } from './input';

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
    expect(surface.handlers.size).toBe(9);
    adapter.dispose();
    expect(surface.handlers.size).toBe(0);
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

import type { EditorSurfaceController } from './controller';

export interface PointerSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly screenX: number;
  readonly screenY: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly isPrimary?: boolean;
  /** DOM PointerEvent.timeStamp; omitted by deterministic headless callers. */
  readonly timeStamp?: number;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export interface WheelSample {
  readonly screenX: number;
  readonly screenY: number;
  readonly deltaY: number;
}

export interface KeyboardSample {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly target?: unknown;
  readonly preventDefault?: () => void;
}

export interface PointerEventSurface {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions | boolean): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  getBoundingClientRect?(): { readonly left: number; readonly top: number };
  contains?(target: unknown): boolean;
}

export interface PointerEventsAdapter {
  dispose(): void;
}

export interface PointerEventsAdapterOptions {
  readonly keyboardSurface?: PointerEventSurface;
  /** Return true when a local interactive target owns this event. */
  readonly shouldExcludeTarget?: (target: unknown, eventType: string) => boolean;
  /** Compatibility spelling for callers that describe the predicate as routing exclusion. */
  readonly excludeFromRouting?: (target: unknown, eventType: string) => boolean;
}

function localPoint(surface: PointerEventSurface, event: PointerEvent): { x: number; y: number } {
  const rect = surface.getBoundingClientRect?.();
  return {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0)
  };
}

function sample(surface: PointerEventSurface, event: PointerEvent): PointerSample {
  const point = localPoint(surface, event);
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    screenX: point.x,
    screenY: point.y,
    button: event.button,
    buttons: event.buttons,
    isPrimary: event.isPrimary,
    ...(Number.isFinite(event.timeStamp) ? { timeStamp: event.timeStamp } : {}),
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  };
}

function isFinitePointerSample(value: PointerSample): boolean {
  return Number.isFinite(value.screenX) && Number.isFinite(value.screenY);
}

function debugTouchPointer(eventName: string, pointer: PointerEvent, point: { x: number; y: number }, timeStamp: number | null, handled?: boolean): void {
  try {
    const debug = globalThis.console?.debug;
    if (typeof debug === 'function') {
      debug.call(globalThis.console, '[Needlewise touch]', eventName, {
        pointerId: pointer.pointerId,
        x: point.x,
        y: point.y,
        timeStamp,
        ...(handled === undefined ? {} : { handled })
      });
    }
  } catch {
    // Diagnostics must never affect pointer transport.
  }
}

/** Attach DOM Pointer Events without putting DOM knowledge in the controller. */
export function createPointerEventsAdapter(
  surface: PointerEventSurface,
  controller: Pick<EditorSurfaceController, 'handlePointerDown' | 'handlePointerMove' | 'handlePointerUp' | 'handlePointerCancel' | 'handlePointerLostCapture' | 'handleWheel' | 'handleKeyDown' | 'handleKeyUp' | 'handleBlur'> & Partial<Pick<EditorSurfaceController, 'handleFocus' | 'handlePointerLeave'>>,
  options: PointerEventsAdapterOptions = {}
): PointerEventsAdapter {
  const keyboardSurface = options.keyboardSurface ?? surface;
  const isExcluded = (event: Event, eventType: string): boolean => {
    const target = (event as { readonly target?: unknown }).target ?? null;
    return options.shouldExcludeTarget?.(target, eventType) === true
      || options.excludeFromRouting?.(target, eventType) === true;
  };
  const onPointerDown = (event: Event): void => {
    if (isExcluded(event, 'pointerdown')) return;
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    const handled = isFinitePointerSample(next) ? controller.handlePointerDown(next) : false;
    if (pointer.pointerType === 'touch') debugTouchPointer('pointerdown', pointer, { x: next.screenX, y: next.screenY }, next.timeStamp ?? null, handled);
    if (handled) {
      surface.setPointerCapture?.(pointer.pointerId);
      event.preventDefault();
    }
  };
  const onPointerMove = (event: Event): void => {
    if (isExcluded(event, 'pointermove')) return;
    const pointer = event as PointerEvent;
    const coalesced = typeof pointer.getCoalescedEvents === 'function' ? pointer.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [pointer];
    let handled = false;
    for (const coalesced of samples) {
      const next = sample(surface, coalesced);
      if (isFinitePointerSample(next)) handled = controller.handlePointerMove(next) || handled;
    }
    if (handled) event.preventDefault();
  };
  const onPointerUp = (event: Event): void => {
    if (isExcluded(event, 'pointerup')) return;
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    const handled = isFinitePointerSample(next) ? controller.handlePointerUp(next) : false;
    if (pointer.pointerType === 'touch') debugTouchPointer('pointerup', pointer, { x: next.screenX, y: next.screenY }, next.timeStamp ?? null, handled);
    if (pointer.pointerType === 'touch') event.preventDefault();
    surface.releasePointerCapture?.(pointer.pointerId);
  };
  const onPointerCancel = (event: Event): void => {
    if (isExcluded(event, 'pointercancel')) return;
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    const handled = isFinitePointerSample(next) ? controller.handlePointerCancel(next) : false;
    if (pointer.pointerType === 'touch') debugTouchPointer('pointercancel', pointer, { x: next.screenX, y: next.screenY }, next.timeStamp ?? null, handled);
    surface.releasePointerCapture?.(pointer.pointerId);
  };
  const onPointerLeave = (): void => { controller.handlePointerLeave?.(); };
  const onLostPointerCapture = (event: Event): void => {
    if (isExcluded(event, 'lostpointercapture')) return;
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    const handled = isFinitePointerSample(next) ? controller.handlePointerLostCapture(next) : false;
    if (pointer.pointerType === 'touch') debugTouchPointer('lostpointercapture', pointer, { x: next.screenX, y: next.screenY }, next.timeStamp ?? null, handled);
  };
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    const point = localPoint(surface, wheel as unknown as PointerEvent);
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(wheel.deltaY)
      && controller.handleWheel({ screenX: point.x, screenY: point.y, deltaY: wheel.deltaY })) event.preventDefault();
  };
  const onKeyDown = (event: Event): void => {
    if (isExcluded(event, 'keydown')) return;
    const keyboard = event as KeyboardEvent;
    controller.handleFocus?.();
    controller.handleKeyDown({
      key: keyboard.key,
      code: keyboard.code,
      ctrlKey: keyboard.ctrlKey,
      metaKey: keyboard.metaKey,
      shiftKey: keyboard.shiftKey,
      altKey: keyboard.altKey,
      target: keyboard.target,
      preventDefault: () => event.preventDefault()
    });
  };
  const onKeyUp = (event: Event): void => {
    if (isExcluded(event, 'keyup')) return;
    const keyboard = event as KeyboardEvent;
    if (controller.handleKeyUp({ key: keyboard.key, code: keyboard.code, target: keyboard.target })) event.preventDefault();
  };
  const onBlur = (event: Event): void => {
    const relatedTarget = (event as FocusEvent).relatedTarget;
    if (relatedTarget && surface.contains?.(relatedTarget) === true) return;
    controller.handleBlur();
  };
  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove, { passive: false });
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerCancel);
  surface.addEventListener('pointerleave', onPointerLeave);
  surface.addEventListener('lostpointercapture', onLostPointerCapture);
  surface.addEventListener('wheel', onWheel, { passive: false });
  keyboardSurface.addEventListener('keydown', onKeyDown);
  keyboardSurface.addEventListener('keyup', onKeyUp);
  surface.addEventListener('blur', onBlur);
  return {
    dispose(): void {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove, false);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerCancel);
      surface.removeEventListener('pointerleave', onPointerLeave);
      surface.removeEventListener('lostpointercapture', onLostPointerCapture);
      surface.removeEventListener('wheel', onWheel, false);
      keyboardSurface.removeEventListener('keydown', onKeyDown);
      keyboardSurface.removeEventListener('keyup', onKeyUp);
      surface.removeEventListener('blur', onBlur);
    }
  };
}

export const createDomPointerEventsAdapter = createPointerEventsAdapter;
export const createPointerAdapter = createPointerEventsAdapter;

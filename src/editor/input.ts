import type { EditorSurfaceController } from './controller';

export interface PointerSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly screenX: number;
  readonly screenY: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly isPrimary?: boolean;
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
}

export interface PointerEventsAdapter {
  dispose(): void;
}

export interface PointerEventsAdapterOptions {
  readonly keyboardSurface?: PointerEventSurface;
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
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey
  };
}

function isFinitePointerSample(value: PointerSample): boolean {
  return Number.isFinite(value.screenX) && Number.isFinite(value.screenY);
}

/** Attach DOM Pointer Events without putting DOM knowledge in the controller. */
export function createPointerEventsAdapter(
  surface: PointerEventSurface,
  controller: Pick<EditorSurfaceController, 'handlePointerDown' | 'handlePointerMove' | 'handlePointerUp' | 'handlePointerCancel' | 'handlePointerLostCapture' | 'handleWheel' | 'handleKeyDown' | 'handleKeyUp' | 'handleBlur'> & Partial<Pick<EditorSurfaceController, 'handleFocus'>>,
  options: PointerEventsAdapterOptions = {}
): PointerEventsAdapter {
  const keyboardSurface = options.keyboardSurface ?? surface;
  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    if (isFinitePointerSample(next) && controller.handlePointerDown(next)) {
      surface.setPointerCapture?.(pointer.pointerId);
      event.preventDefault();
    }
  };
  const onPointerMove = (event: Event): void => {
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
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    if (isFinitePointerSample(next)) controller.handlePointerUp(next);
    surface.releasePointerCapture?.(pointer.pointerId);
  };
  const onPointerCancel = (event: Event): void => {
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    if (isFinitePointerSample(next)) controller.handlePointerCancel(next);
    surface.releasePointerCapture?.(pointer.pointerId);
  };
  const onLostPointerCapture = (event: Event): void => {
    const pointer = event as PointerEvent;
    const next = sample(surface, pointer);
    if (isFinitePointerSample(next)) controller.handlePointerLostCapture(next);
  };
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    const point = localPoint(surface, wheel as unknown as PointerEvent);
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(wheel.deltaY)
      && controller.handleWheel({ screenX: point.x, screenY: point.y, deltaY: wheel.deltaY })) event.preventDefault();
  };
  const onKeyDown = (event: Event): void => {
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
    const keyboard = event as KeyboardEvent;
    if (controller.handleKeyUp({ key: keyboard.key, code: keyboard.code, target: keyboard.target })) event.preventDefault();
  };
  const onBlur = (): void => {
    controller.handleBlur();
  };
  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove, { passive: false });
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerCancel);
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

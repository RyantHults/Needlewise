import type { CanvasContextAdapter, CanvasMetrics, CanvasTarget } from '../editor/contracts';

export const MAX_ATLAS_PIXELS = 16_777_216;
const preparedDprs = new WeakMap<CanvasTarget, number>();

interface CanvasSurface {
  width: number;
  height: number;
  getContext(contextId: '2d'): unknown;
}

/** Adapt a real canvas without allowing Canvas APIs to leak into render logic. */
export function createCanvasTarget(canvas: HTMLCanvasElement): CanvasTarget {
  return createCanvasTargetFromSurface(canvas);
}

export function createCanvasTargetFromSurface(surface: CanvasSurface): CanvasTarget {
  const context = surface.getContext('2d');
  if (!context) throw new Error('A 2D canvas context is required.');
  return {
    context: context as CanvasContextAdapter,
    get width() {
      return surface.width;
    },
    set width(value: number) {
      surface.width = value;
    },
    get height() {
      return surface.height;
    },
    set height(value: number) {
      surface.height = value;
    },
    source: surface,
    resize(width: number, height: number): void {
      surface.width = width;
      surface.height = height;
    }
  };
}

/**
 * Prefer OffscreenCanvas so atlas allocation does not touch the visible DOM.
 * Browsers without it get a detached HTML canvas; unsupported environments
 * return undefined and the renderer uses its bounded primitive fallback.
 */
export function createDefaultAtlasTarget(width: number, height: number): CanvasTarget | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_ATLAS_PIXELS) return undefined;
  try {
    if (typeof globalThis.OffscreenCanvas === 'function') {
      const surface = new globalThis.OffscreenCanvas(width, height);
      return createCanvasTargetFromSurface(surface);
    }
  } catch {
    // Fall through to a detached HTML canvas or the primitive fallback.
  }
  try {
    if (typeof document !== 'undefined') {
      const surface = document.createElement('canvas');
      surface.width = width;
      surface.height = height;
      return createCanvasTarget(surface);
    }
  } catch {
    // jsdom and restricted workers may expose a canvas element without 2D support.
  }
  return undefined;
}

export const defaultAtlasTargetFactory = createDefaultAtlasTarget;

export function resizeTarget(target: CanvasTarget, metrics: CanvasMetrics): boolean {
  if (target.width === metrics.pixelWidth && target.height === metrics.pixelHeight) return false;
  if (target.resize) target.resize(metrics.pixelWidth, metrics.pixelHeight);
  else {
    target.width = metrics.pixelWidth;
    target.height = metrics.pixelHeight;
  }
  return true;
}

export function prepareTarget(target: CanvasTarget, metrics: CanvasMetrics): void {
  const resized = resizeTarget(target, metrics);
  const context = target.context;
  if (resized || preparedDprs.get(target) !== metrics.dpr) {
    context.setTransform?.(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    preparedDprs.set(target, metrics.dpr);
  }
  if (resized) {
    if (context.imageSmoothingEnabled !== undefined) context.imageSmoothingEnabled = false;
  }
}

export function clearTarget(target: CanvasTarget, metrics: CanvasMetrics): void {
  target.context.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight);
}

export function save(context: CanvasContextAdapter): void {
  context.save?.();
}

export function restore(context: CanvasContextAdapter): void {
  context.restore?.();
}

export function drawImage(
  context: CanvasContextAdapter,
  source: unknown,
  sourceWidth: number,
  sourceHeight: number,
  destinationX: number,
  destinationY: number,
  destinationWidth: number,
  destinationHeight: number
): void {
  context.drawImage?.(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    destinationX,
    destinationY,
    destinationWidth,
    destinationHeight
  );
}

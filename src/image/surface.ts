export interface ReadableContext {
  drawImage(...args: unknown[]): void;
  getImageData(sx: number, sy: number, width: number, height: number): { readonly data: ArrayLike<number> };
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: string;
}

/** Backing canvas of a readable surface; needed as the drawImage source when chaining resample steps. */
export interface ReadableCanvas {
  width: number;
  height: number;
}

export interface ReadableSurface {
  readonly context: ReadableContext;
  readonly canvas?: ReadableCanvas;
  dispose?(): void;
}

export type ReadableSurfaceFactory = (width: number, height: number) => ReadableSurface | undefined;

export function createReadableSurface(width: number, height: number): ReadableSurface | undefined {
  try {
    if (typeof globalThis.OffscreenCanvas === 'function') {
      const canvas = new globalThis.OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true }) as ReadableContext | null;
      if (context) return { context, canvas };
    }
  } catch {
    // Fall through to a detached DOM canvas.
  }
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true }) as ReadableContext | null;
      if (context) return { context, canvas };
    }
  } catch {
    // Restricted workers and jsdom may not provide a readable canvas.
  }
  return undefined;
}

export interface PreScaledSource {
  /** The final drawImage source: the last intermediate canvas, or the original source when it already fits. */
  readonly source: unknown;
  readonly width: number;
  readonly height: number;
  /** Releases every surface created during pre-scaling, including the final one. */
  dispose(): void;
}

/**
 * Pre-scale a decoded source to the fitted dimensions: successive exact-2x
 * halvings (each with high-quality smoothing) while a single final draw would
 * still reduce an axis by more than 2x, then one final high-quality draw to
 * the exact fitted size (final reduction factor <=2x per axis, never
 * upscaling). Returns undefined, with every surface released, when a readable
 * surface is unavailable; a throwing step also releases them.
 */
export function preScaleSource(
  source: unknown,
  width: number,
  height: number,
  fittedWidth: number,
  fittedHeight: number,
  factory: ReadableSurfaceFactory = createReadableSurface
): PreScaledSource | undefined {
  const surfaces: ReadableSurface[] = [];
  const releaseAll = (): void => {
    for (const surface of surfaces) {
      if (surface.canvas) {
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      }
      surface.dispose?.();
    }
    surfaces.length = 0;
  };
  let current = source;
  let currentWidth = width;
  let currentHeight = height;
  const drawTo = (nextWidth: number, nextHeight: number): boolean => {
    const surface = factory(nextWidth, nextHeight);
    if (!surface) return false;
    surfaces.push(surface);
    surface.context.imageSmoothingEnabled = true;
    surface.context.imageSmoothingQuality = 'high';
    surface.context.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);
    if (!surface.canvas) return false;
    current = surface.canvas;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
    return true;
  };
  try {
    while (currentWidth > fittedWidth * 2 || currentHeight > fittedHeight * 2) {
      if (!drawTo(Math.ceil(currentWidth / 2), Math.ceil(currentHeight / 2))) {
        releaseAll();
        return undefined;
      }
    }
    if ((currentWidth !== fittedWidth || currentHeight !== fittedHeight) && !drawTo(fittedWidth, fittedHeight)) {
      releaseAll();
      return undefined;
    }
  } catch (error) {
    releaseAll();
    throw error;
  }
  return { source: current, width: currentWidth, height: currentHeight, dispose: releaseAll };
}

export function safeCloseBitmap(bitmap: { close?(): void } | undefined): void {
  try {
    bitmap?.close?.();
  } catch {
    // A failed close must not hide the decode error or result the caller reports.
  }
}

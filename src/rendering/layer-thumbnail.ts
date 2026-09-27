import { CellKind, FIXED_POINT_UNITS_PER_CELL, type Layer, type LayeredDocument, type PaletteEntry } from '../domain';

/**
 * Small previews of one layer's own content for the layers panel. The pixel
 * work is pure so it can be tested without a canvas; `paintLayerThumbnail`
 * only copies the result onto a canvas when one is available.
 */

export const LAYER_THUMBNAIL_SIZE = 40;
/** Thumbnails refresh at most about twice a second while the user edits. */
export const LAYER_THUMBNAIL_INTERVAL_MS = 500;

export interface ThumbnailPixels {
  width: number;
  height: number;
  /** RGBA, row-major; empty cells stay fully transparent. */
  data: Uint8ClampedArray;
}

export function thumbnailDimensions(width: number, height: number, maxSize = LAYER_THUMBNAIL_SIZE): { width: number; height: number; scale: number } {
  const scale = Math.min(maxSize / Math.max(1, width), maxSize / Math.max(1, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

type Rgb = readonly [number, number, number];

function parseHex(color: string): Rgb | undefined {
  const digits = color.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(digits)) return [0, 1, 2].map((index) => parseInt(digits[index]! + digits[index]!, 16)) as unknown as Rgb;
  if (/^[0-9a-f]{6}$/i.test(digits)) return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16)) as unknown as Rgb;
  return undefined;
}

function paletteColors(palette: readonly PaletteEntry[]): Map<number, Rgb> {
  const colors = new Map<number, Rgb>();
  for (const entry of palette) {
    const rgb = parseHex(entry.color);
    if (rgb) colors.set(entry.id, rgb);
  }
  return colors;
}

function setPixel(pixels: ThumbnailPixels, x: number, y: number, rgb: Rgb): void {
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return;
  const offset = (y * pixels.width + x) * 4;
  pixels.data[offset] = rgb[0];
  pixels.data[offset + 1] = rgb[1];
  pixels.data[offset + 2] = rgb[2];
  pixels.data[offset + 3] = 255;
}

/** The first colored component of a cell (full, half, quarter or three-quarter). */
function cellColor(kind: Uint8Array, colors: Uint16Array, index: number): number {
  if (kind[index] === CellKind.Empty) return 0;
  const offset = index * 4;
  return colors[offset] || colors[offset + 1] || colors[offset + 2] || colors[offset + 3] || 0;
}

export function renderLayerThumbnailPixels(document: Pick<LayeredDocument, 'width' | 'height'> & { readonly palette: readonly PaletteEntry[] }, layer: Layer, maxSize = LAYER_THUMBNAIL_SIZE): ThumbnailPixels {
  const { width, height, scale } = thumbnailDimensions(document.width, document.height, maxSize);
  const pixels: ThumbnailPixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const colors = paletteColors(document.palette);

  if (layer.type === 'stitch') {
    if (scale < 1) {
      // Downsampling: every stitched cell marks the pixel it falls in, so
      // sparse detail on a large pattern still shows up.
      for (let y = 0; y < document.height; y += 1) {
        const py = Math.min(height - 1, Math.floor(y * scale));
        for (let x = 0; x < document.width; x += 1) {
          const color = cellColor(layer.kind, layer.colors, y * document.width + x);
          const rgb = color ? colors.get(color) : undefined;
          if (rgb) setPixel(pixels, Math.min(width - 1, Math.floor(x * scale)), py, rgb);
        }
      }
    } else {
      for (let py = 0; py < height; py += 1) {
        const y = Math.min(document.height - 1, Math.floor(py / scale));
        for (let px = 0; px < width; px += 1) {
          const x = Math.min(document.width - 1, Math.floor(px / scale));
          const color = cellColor(layer.kind, layer.colors, y * document.width + x);
          const rgb = color ? colors.get(color) : undefined;
          if (rgb) setPixel(pixels, px, py, rgb);
        }
      }
    }
    return pixels;
  }

  const store = layer.backstitches;
  const unit = scale / FIXED_POINT_UNITS_PER_CELL;
  for (let index = 0; index < store.ids.length; index += 1) {
    const rgb = colors.get(store.colors[index]!);
    if (!rgb) continue;
    const x1 = store.x1[index]! * unit, y1 = store.y1[index]! * unit;
    const x2 = store.x2[index]! * unit, y2 = store.y2[index]! * unit;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      setPixel(pixels, Math.min(width - 1, Math.floor(x1 + (x2 - x1) * t)), Math.min(height - 1, Math.floor(y1 + (y2 - y1) * t)), rgb);
    }
  }
  return pixels;
}

/** Copies thumbnail pixels onto a canvas. Returns false when Canvas 2D is unavailable. */
export function paintLayerThumbnail(canvas: HTMLCanvasElement, pixels: ThumbnailPixels): boolean {
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return false;
  }
  if (!context || typeof ImageData === 'undefined') return false;
  if (canvas.width !== pixels.width) canvas.width = pixels.width;
  if (canvas.height !== pixels.height) canvas.height = pixels.height;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
  return true;
}

/**
 * Whether `next` can look different from `previous`. Edits replace a layer
 * object but keep its name and visibility; rename and show/hide replace it
 * too, yet reuse the same planes, so those alone never need a repaint.
 */
export function layerContentChanged(previous: Layer | null, next: Layer): boolean {
  if (previous === next) return false;
  if (!previous || previous.id !== next.id || previous.type !== next.type) return true;
  const sameStorage = previous.type === 'stitch' && next.type === 'stitch'
    ? previous.kind === next.kind && previous.colors === next.colors
    : previous.type === 'specialty' && next.type === 'specialty' && previous.backstitches === next.backstitches;
  if (!sameStorage) return true;
  return previous.visible === next.visible && previous.name === next.name;
}

/** Changes only when a palette id or color changes, unlike the palette array's identity. */
export function paletteSignature(palette: readonly Pick<PaletteEntry, 'id' | 'color'>[]): string {
  return palette.map((entry) => `${String(entry.id)}:${entry.color}`).join('|');
}

export interface ThumbnailScheduler {
  /** Asks for a refresh; repeated requests inside one interval coalesce. */
  request(): void;
  dispose(): void;
}

type IdleWindow = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Runs `refresh` when the browser is idle, never more than once per
 * `intervalMs`. The first request after a quiet period runs on the next idle
 * slot; requests during an edit burst collapse into one trailing refresh.
 */
export function createThumbnailScheduler(refresh: () => void, intervalMs = LAYER_THUMBNAIL_INTERVAL_MS): ThumbnailScheduler {
  const host = globalThis as IdleWindow;
  let lastRun = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let disposed = false;

  const run = () => {
    idle = null;
    if (disposed) return;
    lastRun = Date.now();
    refresh();
  };
  const onIdle = () => {
    if (host.requestIdleCallback) idle = host.requestIdleCallback(run, { timeout: intervalMs });
    else run();
  };

  return {
    request() {
      if (disposed || timer !== null || idle !== null) return;
      const wait = Math.max(0, lastRun + intervalMs - Date.now());
      timer = setTimeout(() => {
        timer = null;
        onIdle();
      }, wait);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (idle !== null) host.cancelIdleCallback?.(idle);
      timer = null;
      idle = null;
    },
  };
}

export interface ThumbnailQueue {
  /** Replaces any pending job for `key`; jobs run together on the next idle refresh. */
  schedule(key: number, job: () => void): void;
  cancel(key: number): void;
  dispose(): void;
}

/** Dirty thumbnails wait here, so an edit only recomputes the layers it changed, off the render path. */
export function createThumbnailQueue(intervalMs = LAYER_THUMBNAIL_INTERVAL_MS): ThumbnailQueue {
  const pending = new Map<number, () => void>();
  const scheduler = createThumbnailScheduler(() => {
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) job();
  }, intervalMs);
  return {
    schedule(key, job) {
      pending.set(key, job);
      scheduler.request();
    },
    cancel(key) {
      pending.delete(key);
    },
    dispose() {
      pending.clear();
      scheduler.dispose();
    },
  };
}

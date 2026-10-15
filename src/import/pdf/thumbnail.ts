// Page thumbnails for the import review. pdf.js renders into an
// `OffscreenCanvas`, so this works on the main thread and inside the import
// worker alike; platforms without one (Node, jsdom) get no thumbnail.
import type { PDFPageProxy } from 'pdfjs-dist';

interface CanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

/**
 * pdf.js's `CanvasFactory` for threads without a `document`. Its default
 * factory calls `document.createElement` for the scratch canvases used by
 * transparency groups, soft masks and patterns, which fails in a worker.
 */
export class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }

  reset(entry: CanvasAndContext, width: number, height: number): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: CanvasAndContext): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

/**
 * Render a page `targetWidth` pixels wide as a PNG. Resolves undefined when
 * the platform has no `OffscreenCanvas` or rendering fails: a thumbnail must
 * never fail an import.
 */
export async function renderPageThumbnail(page: PDFPageProxy, targetWidth = 200): Promise<Blob | undefined> {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const viewport = page.getViewport({ scale: targetWidth / page.getViewport({ scale: 1 }).width });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    // pdf.js types `canvas` as a DOM canvas, but only calls `getContext` on it.
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return undefined;
  } finally {
    page.cleanup();
  }
}

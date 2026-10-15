// pdf.js loads only through dynamic `import()`, the way `src/export` keeps
// pdf-lib out of the main bundle. Import this module by direct path.
//
// The legacy build is used everywhere: the modern build calls
// `Map.prototype.getOrInsertComputed` and other very recent built-ins with no
// polyfill, which Node 22 and many shipping browsers lack.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { OffscreenCanvasFactory } from './thumbnail';

export type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * pdf.js path opcodes inside `constructPath` buffers and glyph outlines.
 * pdf.js does not export them (`DrawOPS` in `src/shared/util.js`).
 */
export const DrawOps = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4
} as const;

declare global {
  // pdf.js runs its parser on the calling thread when this is set (`PDFWorker`).
  var pdfjsWorker: unknown;
}

let pdfjsPromise: Promise<Pdfjs> | null = null;

async function setup(): Promise<Pdfjs> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Node (Vitest, scripts): pdf.js disables the worker itself and imports its
  // sibling `pdf.worker.mjs` on this thread, so there is nothing to configure.
  if (typeof process === 'object' && String(process) === '[object process]') return pdfjs;

  const { default: workerSrc } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  if (typeof window === 'undefined') {
    // Already inside our import worker: parse on this thread rather than
    // nesting a second worker. The same emitted file serves both cases.
    globalThis.pdfjsWorker ??= await import(/* @vite-ignore */ workerSrc);
  }
  return pdfjs;
}

/** Load pdf.js once, configured for the current thread. */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= setup().catch((error: unknown) => {
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}

/**
 * Open a PDF for primitive extraction. Font faces are disabled so pdf.js
 * builds per-glyph outlines, and kept fonts expose those outlines through
 * `page.commonObjs` (see `glyphOutline`).
 *
 * pdf.js transfers `bytes.buffer` to its parser, which detaches it; pass a
 * copy if the caller still needs the bytes. Release the document with
 * `pdf.loadingTask.destroy()`.
 */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    fontExtraProperties: true,
    useSystemFonts: false,
    // Without a document (our import worker), render scratch canvases off-screen.
    ...(typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined' ? { CanvasFactory: OffscreenCanvasFactory } : {})
  }).promise;
}

/**
 * The outline of one glyph as a `DrawOps` buffer in glyph space (the font
 * matrix already applied, so 1 unit is 1 em). `fontName` is the `setFont`
 * operand (the font's `loadedName`) and `fontChar` is the `fontChar` of a
 * glyph in a `showText` operand. pdf.js sends each outline as a `FontPath`
 * common object named `${loadedName}_path_${fontChar}`, and only once the
 * page's operator list has been built.
 *
 * Returns null for a glyph that has no outline (a space, or a font pdf.js
 * could not parse). The buffer is a Float16Array where the platform has one,
 * otherwise a Float32Array, so callers must quantize before comparing.
 */
export function glyphOutline(page: PDFPageProxy, fontName: string, fontChar: string): ArrayLike<number> | null {
  const id = `${fontName}_path_${fontChar}`;
  if (!page.commonObjs.has(id)) return null;
  const info = page.commonObjs.get(id) as { path?: ArrayLike<number> } | null;
  return info?.path && info.path.length > 0 ? info.path : null;
}

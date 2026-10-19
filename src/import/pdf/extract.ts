// Reduce one PDF page to the primitives the layout and key stages read:
// symbol marks, axis-aligned strokes and fills, text runs and image coverage.
// Everything is in page points, origin top-left, y down.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { throwIfImportCancelled, type ImportColor } from '../types';
import { IDENTITY, apply, drawOpsToPoints, multiply, normalizeDrawOps, outlineDistance, outlineKey, roundToFloat16, type Matrix } from './outline';
import { glyphOutline, loadPdfjs, type Pdfjs } from './pdfjs';
import type { PdfFillRect, PdfMark, PdfPagePrimitives, PdfStroke, PdfTextRun, Rect } from './types';

/** Outlines this close (see `outlineDistance`) are one symbol within an import. */
const SAME_OUTLINE = 0.01;
/** A segment is axis-aligned when it leans by less than this fraction of its length. */
const AXIS_TOLERANCE = 1e-3;
/** Above this many rectangles, one fill path is a batch of backgrounds, never a symbol. */
const MAX_SYMBOL_RECTS = 64;

interface GraphicsState {
  ctm: Matrix;
  fill: ImportColor | null;
  stroke: ImportColor | null;
  lineWidth: number;
  font: string | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

interface FontInfo {
  readonly fontMatrix: readonly number[];
  readonly vertical: boolean;
  readonly isType3Font: boolean;
}

interface ShowTextGlyph {
  readonly fontChar: string;
  readonly unicode: string;
  readonly width: number;
  readonly isSpace: boolean;
  readonly vmetric?: readonly number[];
}

interface Outline {
  readonly d: string;
  readonly symbolKey: string;
  /** Ink bounds under the linear part of the matrix, with y flipped; add the translation to place it. */
  readonly box: Rect;
}

/**
 * Normalized outlines for one document. `byShape` caches each glyph or path
 * under its linear transform; `canonical` merges near-identical outlines
 * (printing noise, rounding of baked coordinates) into one symbol key.
 */
interface OutlineRegistry {
  readonly byShape: Map<string, Outline>;
  readonly canonical: Map<string, { readonly d: string; readonly aspect: number }>;
}

const registries = new WeakMap<PDFDocumentProxy, OutlineRegistry>();

function registryFor(pdf: PDFDocumentProxy): OutlineRegistry {
  let registry = registries.get(pdf);
  if (!registry) {
    registry = { byShape: new Map(), canonical: new Map() };
    registries.set(pdf, registry);
  }
  return registry;
}

function canonicalize(registry: OutlineRegistry, d: string, box: Rect): { d: string; symbolKey: string } {
  const key = outlineKey(d);
  if (registry.canonical.has(key)) return { d: registry.canonical.get(key)?.d ?? d, symbolKey: key };
  const aspect = box.height === 0 ? 0 : box.width / box.height;
  for (const [otherKey, other] of registry.canonical) {
    if (Math.abs(other.aspect - aspect) > 0.05 * Math.max(1, aspect)) continue;
    if (outlineDistance(d, other.d) <= SAME_OUTLINE) return { d: other.d, symbolKey: otherKey };
  }
  registry.canonical.set(key, { d, aspect });
  return { d, symbolKey: key };
}

function outlineFor(registry: OutlineRegistry, cacheKey: string, ops: ArrayLike<number>, m: Matrix): Outline {
  const linear: Matrix = [m[0], m[1], m[2], m[3], 0, 0];
  const shapeKey = `${linear.map((v) => v.toPrecision(9)).join(',')}|${cacheKey}`;
  const cached = registry.byShape.get(shapeKey);
  if (cached) return cached;
  // With no translation and a zero page height, y' = -y: the caller shifts by (e, height - f).
  const { d, bounds } = normalizeDrawOps(ops, linear, 0);
  const outline = { ...canonicalize(registry, d, bounds), box: bounds };
  registry.byShape.set(shapeKey, outline);
  return outline;
}

const place = (outline: Outline, m: Matrix, pageHeight: number): Rect => ({
  x: outline.box.x + m[4],
  y: outline.box.y + pageHeight - m[5],
  width: outline.box.width,
  height: outline.box.height
});

const toColor = (value: unknown): ImportColor | null =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() as ImportColor : null;

/** Unicode a glyph claims, unless it is empty, whitespace or a private-use fallback. */
function unicodeOf(glyph: ShowTextGlyph): string | undefined {
  const text = glyph.unicode;
  if (!text || !text.trim()) return undefined;
  const code = text.codePointAt(0) ?? 0;
  return code >= 0xe000 && code <= 0xf8ff ? undefined : text;
}

async function fontsOf(page: PDFPageProxy, names: ReadonlySet<string>): Promise<Map<string, FontInfo>> {
  const fonts = new Map<string, FontInfo>();
  await Promise.all([...names].map((name) => new Promise<void>((resolve) => {
    // Font objects resolve asynchronously, after the operator list.
    page.commonObjs.get(name, (font: unknown) => {
      if (font && typeof font === 'object') {
        const info = font as Partial<FontInfo>;
        fonts.set(name, {
          fontMatrix: info.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0],
          vertical: info.vertical === true,
          isType3Font: info.isType3Font === true
        });
      }
      resolve();
    });
  })));
  return fonts;
}

/** Axis-aligned line segments of a path in page space (curves are skipped). */
function axisSegments(ops: ArrayLike<number>, m: Matrix): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const subpath of drawOpsToPoints(ops, m)) {
    let px = subpath.x, py = subpath.y;
    const ends = subpath.segments.map((s) => [s[s.length - 2], s[s.length - 1], s.length === 2] as const);
    if (subpath.closed) ends.push([subpath.x, subpath.y, true]);
    for (const [x, y, straight] of ends) {
      const length = Math.hypot(x - px, y - py);
      if (straight && length > 0 && (Math.abs(x - px) <= AXIS_TOLERANCE * length || Math.abs(y - py) <= AXIS_TOLERANCE * length)) {
        out.push([px, py, x, y]);
      }
      px = x;
      py = y;
    }
  }
  return out;
}

/** The path's subpaths as page rectangles, or null unless every one is an axis-aligned rectangle. */
function asRects(ops: ArrayLike<number>, m: Matrix): Rect[] | null {
  const rects: Rect[] = [];
  for (const subpath of drawOpsToPoints(ops, m)) {
    const points: Array<[number, number]> = [[subpath.x, subpath.y]];
    for (const s of subpath.segments) {
      if (s.length !== 2) return null;
      points.push([s[0], s[1]]);
    }
    const [fx, fy] = points[0];
    const [lx, ly] = points[points.length - 1];
    if (points.length === 5 && Math.hypot(lx - fx, ly - fy) < 1e-6) points.pop();
    if (points.length !== 4) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
    const tolerance = AXIS_TOLERANCE * Math.max(width, height);
    const onEdge = (v: number, lo: number, hi: number): boolean => Math.abs(v - lo) <= tolerance || Math.abs(v - hi) <= tolerance;
    if (!points.every(([px, py]) => onEdge(px, x, x + width) && onEdge(py, y, y + height))) return null;
    // Consecutive corners must differ in exactly one axis.
    for (let i = 0; i < 4; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % 4];
      if ((Math.abs(ax - bx) > tolerance) === (Math.abs(ay - by) > tolerance)) return null;
    }
    rects.push({ x, y, width, height });
  }
  if (rects.length === 0) return null;
  if (rects.length > 1 && rects.length <= MAX_SYMBOL_RECTS) {
    // Overlapping or nested rectangles draw one shape (a hollow square, a cross).
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i], b = rects[j];
        const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (overlap > 1e-6 && overlapY > 1e-6) return null;
      }
    }
  }
  return rects;
}

const STROKE_PAINTS = new Set<number>();
const FILL_PAINTS = new Set<number>();

function paintSets(pdfjs: Pdfjs): void {
  if (STROKE_PAINTS.size > 0) return;
  const { OPS } = pdfjs;
  for (const op of [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]) STROKE_PAINTS.add(op);
  for (const op of [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]) FILL_PAINTS.add(op);
}

const unitSquareArea = (m: Matrix): number => Math.abs(m[0] * m[3] - m[1] * m[2]);

/**
 * Extract one page's primitives. The page must belong to `pdf`; symbol keys
 * are shared across every page extracted from the same document.
 */
export async function extractPagePrimitives(pdf: PDFDocumentProxy, pageIndex: number, signal?: AbortSignal): Promise<PdfPagePrimitives> {
  throwIfImportCancelled(signal);
  const pdfjs = await loadPdfjs();
  paintSets(pdfjs);
  const { OPS } = pdfjs;
  const page = await pdf.getPage(pageIndex + 1);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width;
    const height = viewport.height;
    // Maps user space to y-up page space; normalizeDrawOps flips y by `height`.
    const flip: Matrix = [1, 0, 0, -1, 0, height];
    const base = multiply(flip, viewport.transform as unknown as Matrix);
    const [list, textContent] = await Promise.all([
      page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE }),
      page.getTextContent()
    ]);
    throwIfImportCancelled(signal);

    const fontNames = new Set<string>();
    list.fnArray.forEach((fn, i) => {
      const args = list.argsArray[i] as unknown[] | null;
      if (fn === OPS.setFont && typeof args?.[0] === 'string') fontNames.add(args[0]);
      if (fn === OPS.setGState) {
        for (const [key, value] of (args?.[0] ?? []) as Array<[string, unknown]>) {
          if (key === 'Font' && Array.isArray(value) && typeof value[0] === 'string') fontNames.add(value[0]);
        }
      }
    });
    const fonts = await fontsOf(page, fontNames);
    throwIfImportCancelled(signal);

    const registry = registryFor(pdf);
    const marks: PdfMark[] = [];
    const strokes: PdfStroke[] = [];
    const fills: PdfFillRect[] = [];
    let imageArea = 0;

    let state: GraphicsState = {
      ctm: IDENTITY, fill: '#000000', stroke: '#000000', lineWidth: 1,
      font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, renderMode: 0
    };
    const stack: GraphicsState[] = [];
    let textMatrix: Matrix = IDENTITY;
    // Current point and line start in text space, as pdf.js's canvas tracks them.
    let tx = 0, ty = 0, lineX = 0, lineY = 0;

    const toPage = (m: Matrix): Matrix => multiply(base, m);
    const addImage = (m: Matrix): void => {
      imageArea += unitSquareArea(multiply(viewport.transform as unknown as Matrix, m));
    };

    const showText = (glyphs: ReadonlyArray<ShowTextGlyph | number>): void => {
      const font = state.font ? fonts.get(state.font) : undefined;
      if (!font || !state.font || state.fontSize === 0) return;
      const direction = state.fontSize < 0 ? -1 : 1;
      const size = Math.abs(state.fontSize);
      const h = state.hScale * direction;
      const advanceScale = size * font.fontMatrix[0];
      const mode = state.renderMode & 3;
      const color = mode === 1 ? state.stroke : mode === 3 ? null : state.fill;
      // Invisible text (modes 3 and 7), such as an OCR layer, draws nothing.
      const visible = color !== null && !font.isType3Font;
      const textToUser = multiply(state.ctm, textMatrix);
      let x = 0;
      for (const glyph of glyphs) {
        if (typeof glyph === 'number') {
          x += (font.vertical ? 1 : -1) * glyph * size / 1000;
          continue;
        }
        const spacing = (glyph.isSpace ? state.wordSpacing : 0) + state.charSpacing;
        if (visible && color && !font.vertical) {
          const path = glyphOutline(page, state.font, glyph.fontChar);
          if (path) {
            const glyphMatrix: Matrix = [h * size, 0, 0, direction > 0 ? size : -size, tx + h * x, ty + state.rise];
            const m = toPage(multiply(textToUser, glyphMatrix));
            const outline = outlineFor(registry, `g|${state.font}|${glyph.fontChar}`, roundToFloat16(path), m);
            const unicode = unicodeOf(glyph);
            marks.push({
              kind: 'glyph',
              bounds: place(outline, m, height),
              symbolKey: outline.symbolKey,
              outlineD: outline.d,
              ...(unicode ? { unicode } : {}),
              color
            });
          }
        }
        x += font.vertical
          ? -(glyph.vmetric?.[0] ?? glyph.width) * advanceScale - spacing * direction
          : glyph.width * advanceScale + spacing * direction;
      }
      if (font.vertical) ty -= x;
      else tx += x * h;
    };

    for (let i = 0; i < list.fnArray.length; i += 1) {
      const fn = list.fnArray[i];
      const args = (list.argsArray[i] ?? []) as unknown[];
      switch (fn) {
        case OPS.save:
        case OPS.beginGroup:
          stack.push({ ...state });
          break;
        case OPS.restore:
        case OPS.endGroup:
        case OPS.paintFormXObjectEnd:
          state = stack.pop() ?? state;
          break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ...state });
          if (args[0]) state.ctm = multiply(state.ctm, Array.from(args[0] as ArrayLike<number>) as unknown as Matrix);
          break;
        case OPS.transform:
          state.ctm = multiply(state.ctm, args as unknown as Matrix);
          break;
        case OPS.setFillRGBColor:
          state.fill = toColor(args[0]);
          break;
        case OPS.setStrokeRGBColor:
          state.stroke = toColor(args[0]);
          break;
        case OPS.setFillColorN:
        case OPS.setFillTransparent:
          // Pattern and missing fills have no single color.
          state.fill = null;
          break;
        case OPS.setStrokeColorN:
        case OPS.setStrokeTransparent:
          state.stroke = null;
          break;
        case OPS.setLineWidth:
          state.lineWidth = args[0] as number;
          break;
        case OPS.setGState:
          for (const [key, value] of (args[0] ?? []) as Array<[string, unknown]>) {
            if (key === 'LW' && typeof value === 'number') state.lineWidth = value;
            if (key === 'Font' && Array.isArray(value)) {
              state.font = value[0] as string;
              state.fontSize = value[1] as number;
            }
          }
          break;
        case OPS.setFont:
          state.font = args[0] as string;
          state.fontSize = args[1] as number;
          break;
        case OPS.setCharSpacing:
          state.charSpacing = args[0] as number;
          break;
        case OPS.setWordSpacing:
          state.wordSpacing = args[0] as number;
          break;
        case OPS.setHScale:
          state.hScale = (args[0] as number) / 100;
          break;
        case OPS.setLeading:
          state.leading = -(args[0] as number);
          break;
        case OPS.setTextRise:
          state.rise = args[0] as number;
          break;
        case OPS.setTextRenderingMode:
          state.renderMode = args[0] as number;
          break;
        case OPS.beginText:
          textMatrix = IDENTITY;
          tx = ty = lineX = lineY = 0;
          break;
        case OPS.setTextMatrix:
          textMatrix = Array.from(args[0] as ArrayLike<number>) as unknown as Matrix;
          tx = ty = lineX = lineY = 0;
          break;
        case OPS.moveText:
          tx = lineX += args[0] as number;
          ty = lineY += args[1] as number;
          break;
        case OPS.setLeadingMoveText:
          state.leading = args[1] as number;
          tx = lineX += args[0] as number;
          ty = lineY += args[1] as number;
          break;
        case OPS.nextLine:
          tx = lineX;
          ty = lineY += state.leading;
          break;
        case OPS.showText:
          showText(args[0] as ReadonlyArray<ShowTextGlyph | number>);
          break;
        case OPS.constructPath: {
          const paint = args[0] as number;
          const buffer = (args[1] as [ArrayLike<number> | null] | undefined)?.[0];
          if (!buffer || buffer.length === 0) break;
          const m = toPage(state.ctm);
          if (STROKE_PAINTS.has(paint) && state.stroke) {
            const pageMatrix = multiply(viewport.transform as unknown as Matrix, state.ctm);
            const strokeWidth = state.lineWidth * Math.sqrt(unitSquareArea(pageMatrix));
            for (const [x1, y1, x2, y2] of axisSegments(buffer, pageMatrix)) {
              strokes.push({ x1, y1, x2, y2, width: strokeWidth, color: state.stroke });
            }
          }
          if (FILL_PAINTS.has(paint) && state.fill) {
            const rects = asRects(buffer, multiply(viewport.transform as unknown as Matrix, state.ctm));
            if (rects) {
              for (const bounds of rects) {
                if (bounds.width > 0 && bounds.height > 0) fills.push({ bounds, color: state.fill });
              }
            } else {
              const outline = outlineFor(registry, `p|${Array.prototype.join.call(buffer, ',')}`, buffer, m);
              // A zero-area fill (a degenerate `re`) paints nothing.
              if (outline.box.width === 0 || outline.box.height === 0) break;
              marks.push({ kind: 'path', bounds: place(outline, m, height), symbolKey: outline.symbolKey, outlineD: outline.d, color: state.fill });
            }
          }
          break;
        }
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject:
        case OPS.paintSolidColorImageMask:
          addImage(state.ctm);
          break;
        case OPS.paintImageXObjectRepeat: {
          const [, scaleX, scaleY, positions] = args as [unknown, number, number, ArrayLike<number>];
          for (let p = 0; p < positions.length; p += 2) addImage(multiply(state.ctm, [scaleX, 0, 0, scaleY, positions[p], positions[p + 1]]));
          break;
        }
        case OPS.paintImageMaskXObjectRepeat: {
          const [, scaleX, skewX, skewY, scaleY, positions] = args as [unknown, number, number, number, number, ArrayLike<number>];
          for (let p = 0; p < positions.length; p += 2) addImage(multiply(state.ctm, [scaleX, skewX, skewY, scaleY, positions[p], positions[p + 1]]));
          break;
        }
        case OPS.paintImageMaskXObjectGroup:
          for (const image of args[0] as Array<{ transform: Matrix }>) addImage(multiply(state.ctm, image.transform));
          break;
        case OPS.paintInlineImageXObjectGroup:
          for (const entry of args[1] as Array<{ transform: Matrix }>) addImage(multiply(state.ctm, entry.transform));
          break;
        default:
          break;
      }
    }

    const text: PdfTextRun[] = [];
    for (const item of textContent.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const m = multiply(viewport.transform as unknown as Matrix, item.transform as unknown as Matrix);
      const fontSize = Math.hypot(m[2], m[3]);
      const [x, baseline] = apply(m, 0, 0);
      text.push({ text: item.str, bounds: { x, y: baseline - fontSize, width: item.width, height: fontSize }, fontSize });
    }

    return {
      pageIndex,
      width,
      height,
      marks,
      strokes,
      fills,
      text,
      imageCoverage: Math.min(1, imageArea / (width * height))
    };
  } finally {
    page.cleanup();
  }
}

/** The document's `/Title`, or the XMP `dc:title`, when either is set. */
export async function readPdfTitle(pdf: PDFDocumentProxy): Promise<string | undefined> {
  const { info, metadata } = await pdf.getMetadata();
  const fromInfo = (info as { Title?: unknown } | null)?.Title;
  const title = typeof fromInfo === 'string' && fromInfo.trim() ? fromInfo : metadata?.get('dc:title');
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

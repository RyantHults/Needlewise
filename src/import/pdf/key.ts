// Key (legend) page reading. Pure: works on extracted page primitives only.
//
// A key row is a symbol mark beside a thread code, optionally with a name and
// a color swatch. Every glyph on a page is a mark, including the key's own
// label text, so the symbol of a row is chosen by position: the leftmost
// usable mark of the row, or the mark in a "Symbol" column when the key has a
// header row. Marks that are part of a word are label text and never become
// symbols unless they sit in a Symbol column.
import type { ImportColor, ImportedKeyEntry } from '../types';
import type { PdfFillRect, PdfMark, PdfPagePrimitives, PdfTextRun, Rect } from './types';
import { rectCenter } from './types';

type ColumnKind = 'symbol' | 'code' | 'name' | 'other';

interface Column {
  readonly kind: ColumnKind;
  /** Brand for a code column (`DMC`, `ANCHOR`), upper case. */
  readonly brand?: string;
  readonly left: number;
  readonly right: number;
}

interface Word {
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly run: PdfTextRun;
}

type Item = { readonly type: 'mark'; readonly mark: PdfMark } | { readonly type: 'word'; readonly word: Word };

interface Row {
  top: number;
  bottom: number;
  readonly items: Item[];
}

const BRANDS: Readonly<Record<string, string>> = { dmc: 'DMC', anchor: 'ANCHOR', madeira: 'MADEIRA', cosmo: 'COSMO', 'j&p': 'COATS', coats: 'COATS' };
const HEADER_KIND: Readonly<Record<string, ColumnKind>> = {
  symbol: 'symbol', symbols: 'symbol', sym: 'symbol',
  code: 'code', number: 'code', no: 'code', thread: 'code', floss: 'code',
  name: 'name', description: 'name', colour: 'name', color: 'name',
  stitches: 'other', count: 'other', full: 'other', half: 'other', '3/4': 'other', '1/4': 'other', back: 'other',
  length: 'other', skeins: 'other', strands: 'other', total: 'other'
};

const SINGLE_CODE = /^(?:[A-Z]{0,2}\d{1,4}[A-Z]?|B5200|ecru|blanc|white)$/i;
const BLEND = /^[A-Z]{0,2}\d{1,4}[A-Z]?(?:[+/][A-Z]{0,2}\d{1,4}[A-Z]?)+$/i;
const NUMERIC = /^[\d.,:%–—\-+/x×()]+$/i;

const centerX = (r: Rect): number => rectCenter(r).x;
const centerY = (r: Rect): number => rectCenter(r).y;
const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
const insideAny = (rects: readonly Rect[], r: Rect): boolean => rects.some((e) => contains(e, centerX(r), centerY(r)));

function headerWord(text: string): { kind: ColumnKind; brand?: string } | undefined {
  const lower = text.toLowerCase().replace(/[.:#]+$/, '');
  const brand = BRANDS[lower];
  if (brand) return { kind: 'code', brand };
  const kind = HEADER_KIND[lower];
  return kind ? { kind } : undefined;
}

/** Split a run into words, placing each by its share of the run's characters. */
function wordsOf(run: PdfTextRun): Word[] {
  const words: Word[] = [];
  const length = run.text.length;
  if (length === 0) return words;
  const perChar = run.bounds.width / length;
  for (const match of run.text.matchAll(/\S+/g)) {
    const start = match.index;
    words.push({
      text: match[0],
      left: run.bounds.x + start * perChar,
      right: run.bounds.x + (start + match[0].length) * perChar,
      top: run.bounds.y,
      bottom: run.bounds.y + run.bounds.height,
      run
    });
  }
  return words;
}

function itemBox(item: Item): { top: number; bottom: number; x: number } {
  if (item.type === 'mark') {
    const b = item.mark.bounds;
    return { top: b.y, bottom: b.y + b.height, x: centerX(b) };
  }
  const { word } = item;
  return { top: word.top, bottom: word.bottom, x: (word.left + word.right) / 2 };
}

/** Group items into rows: an item joins the open row when its vertical center lies inside it. */
function groupRows(items: readonly Item[]): Row[] {
  const sorted = items
    .map((item) => ({ item, ...itemBox(item) }))
    .sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
  const rows: Row[] = [];
  let open: Row | undefined;
  for (const entry of sorted) {
    const middle = (entry.top + entry.bottom) / 2;
    if (open && middle >= open.top && middle <= open.bottom) {
      open.items.push(entry.item);
      open.top = Math.min(open.top, entry.top);
      open.bottom = Math.max(open.bottom, entry.bottom);
    } else {
      open = { top: entry.top, bottom: entry.bottom, items: [entry.item] };
      rows.push(open);
    }
  }
  return rows;
}

/** Columns from a header row with at least two header words, one of them a symbol or code column. */
function headerColumns(row: Row): Column[] | undefined {
  const heads: Array<{ kind: ColumnKind; brand?: string; left: number }> = [];
  for (const item of row.items) {
    if (item.type !== 'word') continue;
    const head = headerWord(item.word.text);
    if (head) heads.push({ ...head, left: item.word.left });
  }
  if (heads.length < 2 || !heads.some((h) => h.kind === 'symbol' || h.kind === 'code')) return undefined;
  heads.sort((a, b) => a.left - b.left);
  const pitch = heads.length > 1 ? (heads[heads.length - 1].left - heads[0].left) / (heads.length - 1) : 50;
  // A column starts a little left of its header so left-aligned values just
  // outside the header's text still belong to it.
  const slack = Math.min(6, pitch / 4);
  return heads.map((head, index) => ({
    kind: head.kind,
    ...(head.brand ? { brand: head.brand } : {}),
    left: head.left - slack,
    right: index + 1 < heads.length ? heads[index + 1].left - slack : Number.POSITIVE_INFINITY
  }));
}

function columnAt(columns: readonly Column[], x: number): Column | undefined {
  return columns.find((c) => x >= c.left && x < c.right);
}

function pageBrand(words: readonly Word[]): string {
  const named = new Set<string>();
  for (const word of words) {
    const brand = BRANDS[word.text.toLowerCase().replace(/[^a-z&]/g, '')];
    if (brand) named.add(brand);
  }
  if (named.has('DMC') || named.size === 0) return 'DMC';
  return [...named][0];
}

function codeOf(text: string): { code: string; blendCodes?: string[] } | undefined {
  const token = text.replace(/[,;]$/, '');
  if (BLEND.test(token)) {
    const blendCodes = token.split(/[+/]/);
    return { code: blendCodes[0], blendCodes };
  }
  if (SINGLE_CODE.test(token)) return { code: /^\d|^B5200$/i.test(token) ? token.toUpperCase() : capitalize(token) };
  return undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function swatchFor(fills: readonly PdfFillRect[], row: Row, symbol: PdfMark, codeLeft: number): ImportColor | undefined {
  const height = row.bottom - row.top;
  let best: PdfFillRect | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const fill of fills) {
    const b = fill.bounds;
    const middle = centerY(b);
    if (middle < row.top - height * 0.25 || middle > row.bottom + height * 0.25) continue;
    // Row stripes and table backgrounds are not swatches.
    if (b.width > Math.max(height, symbol.bounds.width) * 4) continue;
    if (b.x >= codeLeft) continue;
    if (contains(b, centerX(symbol.bounds), centerY(symbol.bounds))) return fill.color;
    const distance = Math.abs(centerX(b) - centerX(symbol.bounds));
    if (distance < bestDistance) {
      best = fill;
      bestDistance = distance;
    }
  }
  return best?.color;
}

/**
 * Read thread key rows from one page. Marks, words and fills whose center lies
 * inside an `exclude` rect (a chart lattice on the same page) are ignored.
 * Returns one entry per symbol, first row wins; [] when the page has no rows.
 */
export function readKeyPage(page: PdfPagePrimitives, exclude: readonly Rect[] = []): ImportedKeyEntry[] {
  const marks = page.marks.filter((m) => !insideAny(exclude, m.bounds));
  const runs = page.text.filter((t) => !insideAny(exclude, t.bounds));
  const fills = page.fills.filter((f) => !insideAny(exclude, f.bounds));
  const words = runs.flatMap(wordsOf);

  // A glyph mark inside a word of two or more characters is label text. The
  // same outline standing alone can still be a symbol: letter symbols (X, S,
  // O) are common and share the label font.
  const multiCharRuns = runs.filter((run) => run.text.replace(/\s+/g, '').length > 1);
  const isLabel = (mark: PdfMark): boolean => mark.kind === 'glyph' &&
    multiCharRuns.some((run) => contains(run.bounds, centerX(mark.bounds), centerY(mark.bounds)));

  const items: Item[] = [
    ...marks.map((mark): Item => ({ type: 'mark', mark })),
    ...words.map((word): Item => ({ type: 'word', word }))
  ];
  const rows = groupRows(items);
  const defaultBrand = pageBrand(words);
  const entries: ImportedKeyEntry[] = [];
  const seen = new Set<string>();
  let columns: Column[] | undefined;

  for (const row of rows) {
    const header = headerColumns(row);
    if (header) {
      columns = header;
      continue;
    }
    for (const entry of readRow(row, columns, isLabel, fills, defaultBrand)) {
      if (seen.has(entry.symbolKey)) continue;
      seen.add(entry.symbolKey);
      entries.push(entry);
    }
  }
  return entries;
}

function readRow(
  row: Row,
  columns: readonly Column[] | undefined,
  isLabel: (mark: PdfMark) => boolean,
  fills: readonly PdfFillRect[],
  defaultBrand: string
): ImportedKeyEntry[] {
  const marks = row.items.flatMap((i) => (i.type === 'mark' ? [i.mark] : [])).sort((a, b) => a.bounds.x - b.bounds.x);
  const words = row.items.flatMap((i) => (i.type === 'word' ? [i.word] : [])).sort((a, b) => a.left - b.left);
  const middle = (w: Word): number => (w.left + w.right) / 2;
  // A symbol drawn as a font glyph also comes back as text; that text is the
  // symbol, not a code or a name.
  const symbolText = (w: Word): boolean => marks.some((m) => !isLabel(m) && contains(m.bounds, middle(w), (w.top + w.bottom) / 2));

  // Each table segment starts at a symbol column (side-by-side keys repeat
  // their header), or is the whole row when there is no usable header.
  const symbolColumns = columns?.filter((c) => c.kind === 'symbol') ?? [];
  const segments: Array<{ left: number; right: number; symbolColumn?: Column }> = symbolColumns.length > 0
    ? symbolColumns.map((column, index) => ({ left: column.left, right: symbolColumns[index + 1]?.left ?? Number.POSITIVE_INFINITY, symbolColumn: column }))
    : [{ left: Number.NEGATIVE_INFINITY, right: Number.POSITIVE_INFINITY }];

  const entries: ImportedKeyEntry[] = [];
  for (const segment of segments) {
    const within = (x: number): boolean => x >= segment.left && x < segment.right;
    const segmentWords = words.filter((w) => within(middle(w)));
    const segmentColumns = columns?.filter((c) => within(c.left)) ?? [];
    const codeColumns = segmentColumns.filter((c) => c.kind === 'code');
    const nameColumns = segmentColumns.filter((c) => c.kind === 'name');

    // Prefer DMC when a key prints several brand columns.
    const codeWords = codeColumns.length > 0
      ? segmentWords.filter((w) => columnAt(codeColumns, middle(w))).sort((a, b) => brandRank(codeColumns, a) - brandRank(codeColumns, b))
      : segmentWords.filter((w) => !symbolText(w));
    let code: { code: string; blendCodes?: string[] } | undefined;
    let codeWord: Word | undefined;
    for (const word of codeWords) {
      code = codeOf(word.text);
      if (code) {
        codeWord = word;
        break;
      }
    }
    if (!code || !codeWord) continue;

    const symbolLimit = codeColumns.length > 0 ? Math.min(...codeColumns.map((c) => c.left)) : codeWord.left;
    const candidates = marks.filter((m) => within(centerX(m.bounds)) && centerX(m.bounds) < symbolLimit);
    const symbol = segment.symbolColumn
      ? candidates.find((m) => !isLabel(m)) ?? candidates[0]
      : candidates.find((m) => !isLabel(m));
    if (!symbol) continue;

    const symbolRight = symbol.bounds.x + symbol.bounds.width;
    const nameWords = segmentWords.filter((w) => {
      if (w === codeWord || symbolText(w)) return false;
      if (nameColumns.length > 0) return columnAt(nameColumns, middle(w)) !== undefined;
      if (columnAt(segmentColumns, middle(w))) return false;
      return w.left >= symbolRight && !NUMERIC.test(w.text) && !/\d/.test(w.text);
    });
    const name = nameWords
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((w) => w.text)
      .join(' ');
    const color = swatchFor(fills, row, symbol, codeWord.left);
    const brand = columnAt(codeColumns, middle(codeWord))?.brand ?? defaultBrand;
    entries.push({
      symbolKey: symbol.symbolKey,
      brand,
      code: code.code,
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      ...(code.blendCodes ? { blendCodes: code.blendCodes } : {})
    });
  }
  return entries;
}

function brandRank(codeColumns: readonly Column[], word: Word): number {
  const column = columnAt(codeColumns, (word.left + word.right) / 2);
  return column?.brand === 'DMC' ? 0 : column?.brand === undefined ? 1 : 2;
}

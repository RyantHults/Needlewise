import { describe, expect, it } from 'vitest';
import { CellKind, createDocument } from '../domain';
import {
  ConversionError,
  ConversionCancelledError,
  acceptConversionDraft,
  convertRasterToPatternAsync,
  convertRasterToPattern,
  createConversionImageRequest,
  createConversionRequest,
  resampleRaster,
  resampleRasterAsync,
  trimDocumentToContent,
  validateAcceptedConversionDraft,
  validateConversionRequest,
  type ConversionRaster
} from './image-to-pattern';

const catalog = [
  { sourceId: 'black', code: '310', name: 'Black', hex: '#000000' as const, rgb: [0, 0, 0] as const },
  { sourceId: 'white', code: 'B5200', name: 'White', hex: '#FFFFFF' as const, rgb: [255, 255, 255] as const },
  { sourceId: 'red', code: '666', name: 'Red', hex: '#FF0000' as const, rgb: [255, 0, 0] as const },
  { sourceId: 'blue', code: '797', name: 'Blue', hex: '#0000FF' as const, rgb: [0, 0, 255] as const }
];

const orderingCatalog = [
  { sourceId: 'black', code: '310', name: 'Black', hex: '#000000' as const, rgb: [0, 0, 0] as const },
  { sourceId: 'white', code: 'B5200', name: 'White', hex: '#FFFFFF' as const, rgb: [255, 255, 255] as const },
  { sourceId: 'red', code: '666', name: 'Red', hex: '#FF0000' as const, rgb: [255, 0, 0] as const },
  { sourceId: 'green', code: '700', name: 'Green', hex: '#00FF00' as const, rgb: [0, 255, 0] as const },
  { sourceId: 'blue', code: '797', name: 'Blue', hex: '#0000FF' as const, rgb: [0, 0, 255] as const },
  { sourceId: 'magenta', code: '800', name: 'Magenta', hex: '#FF00FF' as const, rgb: [255, 0, 255] as const }
];

/** Eight pixels: red x4, blue x2, green x1, magenta x1. */
const orderedPixels = [
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  0, 0, 255, 255, 0, 0, 255, 255,
  0, 255, 0, 255,
  255, 0, 255, 255
];

function raster(width: number, height: number, pixels: readonly number[]): ConversionRaster {
  return { width, height, pixels: new Uint8ClampedArray(pixels) };
}

describe('deterministic image conversion core', () => {
  it('maps pixels to a bounded catalog palette ranked by usage with ids assigned by rank', () => {
    const input = raster(2, 2, [
      255, 0, 0, 255, 0, 0, 255, 255,
      255, 0, 0, 255, 0, 0, 0, 0
    ]);
    const first = convertRasterToPattern(input, { targetWidth: 2, targetHeight: 2, paletteBudget: 3, catalog, token: { projectId: 'p', baseRevision: 4, requestId: 'r' } });
    const second = convertRasterToPattern(input, { targetWidth: 2, targetHeight: 2, paletteBudget: 3, catalog, token: { projectId: 'p', baseRevision: 4, requestId: 'r' } });

    // Red x2, blue x1 — no forced Black/White entries.
    expect(first.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue']);
    expect(first.document.palette.map((entry) => entry.id)).toEqual([1, 2]);
    expect(first.document.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Full, CellKind.Full, CellKind.Empty]));
    expect(first.document.colors[0]).toBe(1);
    expect(first.document.colors[4]).toBe(2);
    expect(first.document.colors[8]).toBe(1);
    expect(first.document.colors[12]).toBe(0);
    expect(first.sourceImage.traceVisible).toBe(false);
    expect(first.stats.transparentPixels).toBe(1);
    expect(first.stats.emptyPixels).toBe(1);
    expect(first.document.kind).toEqual(second.document.kind);
    expect(first.document.colors).toEqual(second.document.colors);
    expect(first.document.palette).toEqual(second.document.palette);
    expect(second.sourceImage.traceVisible).toBe(false);
    const accepted = acceptConversionDraft(first);
    expect(accepted.sourceImage.traceVisible).toBe(false);
    expect(() => validateAcceptedConversionDraft(accepted)).not.toThrow();
  });

  it('includes Black and White only when the image actually contains them', () => {
    const blackDraft = convertRasterToPattern(raster(1, 1, [0, 0, 0, 255]), { targetWidth: 1, targetHeight: 1, paletteBudget: 3, catalog });
    expect(blackDraft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['black']);
    expect(blackDraft.document.colors[0]).toBe(1);
    const whiteDraft = convertRasterToPattern(raster(1, 1, [255, 255, 255, 255]), { targetWidth: 1, targetHeight: 1, paletteBudget: 3, catalog });
    expect(whiteDraft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['white']);
  });

  it('uses catalog order for exact squared-RGB ties', () => {
    const tieCatalog = [
      catalog[0],
      catalog[1],
      { sourceId: 'near-a', code: 'a', name: 'A', hex: '#00000A' as const, rgb: [0, 0, 10] as const },
      { sourceId: 'near-b', code: 'b', name: 'B', hex: '#000014' as const, rgb: [0, 0, 20] as const }
    ];
    const draft = convertRasterToPattern(raster(1, 1, [0, 0, 15, 255]), { targetWidth: 1, targetHeight: 1, paletteBudget: 4, catalog: tieCatalog });
    expect(draft.document.colors[0]).toBe(1);
    expect(draft.document.palette[0].catalog?.sourceId).toBe('near-a');
  });

  it('resamples deterministically and copies the source pixel plane', () => {
    const input = raster(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const output = resampleRaster(input, 1, 1);
    expect(output.pixels).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
    expect(output.sourceWidth).toBe(2);
    expect(input.pixels).toEqual(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]));
  });

  it('skips a selected white background and accepts an empty-palette draft', () => {
    const draft = convertRasterToPattern(raster(1, 1, [255, 255, 255, 255]), { targetWidth: 1, targetHeight: 1, backgroundSourceId: 'white', catalog });
    expect(draft.document.kind[0]).toBe(CellKind.Empty);
    expect(draft.stats.emptyPixels).toBe(1);
    expect(draft.stats.matchedColorCount).toBe(0);
    // All pixels were skipped: the draft carries a zero-entry palette and is
    // still valid for creation, matching the empty starter convention.
    expect(draft.document.palette).toEqual([]);
    expect(() => validateAcceptedConversionDraft(draft as never)).toThrow(ConversionError);
    const accepted = acceptConversionDraft(draft);
    expect(() => validateAcceptedConversionDraft(accepted)).not.toThrow();
  });

  it('copies raster data into the worker request and validates its bounds', () => {
    const input = raster(1, 1, [1, 2, 3, 255]);
    const request = createConversionRequest(input, { targetWidth: 1, targetHeight: 1, token: { projectId: 'p', baseRevision: 0, requestId: 'r' } });
    expect(request.pixels).not.toBe(input.pixels);
    expect(() => validateConversionRequest(request)).not.toThrow();
    expect(() => validateConversionRequest({ ...request, pixels: new Uint8ClampedArray(3) })).toThrow(ConversionError);
  });

  it('accepts rasters whose recorded source dimensions exceed the working bounds', () => {
    // The decode path pre-scales oversized bitmaps to the working bounds, but
    // the recorded source dimensions keep the true original size so the
    // retained reference asset (original bytes) stays consistent with the draft.
    const input = {
      width: 2,
      height: 2,
      sourceWidth: 6_000,
      sourceHeight: 4_000,
      pixels: new Uint8ClampedArray([
        255, 0, 0, 255, 0, 0, 255, 255,
        255, 0, 0, 255, 0, 0, 255, 255
      ])
    };
    const draft = convertRasterToPattern(input, { targetWidth: 2, targetHeight: 2, paletteBudget: 3, catalog });
    expect(draft.stats.sourceWidth).toBe(6_000);
    expect(draft.stats.sourceHeight).toBe(4_000);
    const accepted = acceptConversionDraft(draft);
    expect(() => validateAcceptedConversionDraft(accepted)).not.toThrow();
    const request = createConversionRequest({ ...input, sourceWidth: 8_000, sourceHeight: 6_000 }, { targetWidth: 2, targetHeight: 2, token: { projectId: 'p', baseRevision: 0, requestId: 'large-source' } });
    expect(() => validateConversionRequest(request)).not.toThrow();
  });

  it('still rejects genuinely invalid recorded source dimensions', () => {
    const invalid = { width: 1, height: 1, sourceWidth: 0, sourceHeight: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) };
    expect(() => convertRasterToPattern(invalid, { targetWidth: 1, targetHeight: 1, catalog })).toThrow(ConversionError);
    expect(() => createConversionRequest(invalid, { targetWidth: 1, targetHeight: 1 })).toThrow(ConversionError);
  });

  it('selects palette colors in descending pixel usage, preferring lower catalog indices on exact ties', () => {
    const source = raster(8, 1, orderedPixels);
    // Budget 6 keeps every pixel's own color, so palette entry order and usage
    // reflect the raw counts: red 4, blue 2, green 1, magenta 1. Black and
    // White are absent because the image contains neither.
    const full = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog });
    expect(full.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue', 'green', 'magenta']);
    expect(full.document.palette.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(full.stats.paletteUsage.map((entry) => [entry.catalogId, entry.count])).toEqual([['red', 4], ['blue', 2], ['green', 1], ['magenta', 1]]);
  });

  it('selects only the single most-used color at budget 1', () => {
    const source = raster(8, 1, orderedPixels);
    const draft = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 1, catalog: orderingCatalog });
    expect(draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    expect(draft.document.palette.map((entry) => entry.id)).toEqual([1]);
    // Everything remaps onto the single kept color.
    expect(draft.stats.paletteUsage.map((entry) => [entry.catalogId, entry.count])).toEqual([['red', 8]]);
    expect(draft.stats.stitchedPixels).toBe(8);
  });

  it('rejects a zero palette budget', () => {
    const source = raster(8, 1, orderedPixels);
    expect(() => convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 0, catalog: orderingCatalog })).toThrow(ConversionError);
  });

  it('counts distinct matched catalog colors among pixels that survive the skips', () => {
    const source = raster(8, 1, orderedPixels);
    const full = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog });
    expect(full.stats.matchedColorCount).toBe(4);
    const withBackground = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog, backgroundSourceId: 'blue' });
    expect(withBackground.stats.matchedColorCount).toBe(3);
    const allTransparent = convertRasterToPattern(raster(2, 1, [0, 0, 0, 0, 0, 0, 0, 0]), { targetWidth: 2, targetHeight: 1, catalog });
    expect(allTransparent.stats.matchedColorCount).toBe(0);
    const withWhiteSkip = convertRasterToPattern(raster(2, 1, [255, 255, 255, 255, 255, 0, 0, 255]), { targetWidth: 2, targetHeight: 1, catalog, backgroundSourceId: 'white' });
    expect(withWhiteSkip.stats.matchedColorCount).toBe(1);
  });

  it('drops the least-used color when the budget shrinks and adds it back when it grows', () => {
    const source = raster(8, 1, orderedPixels);
    const atTwo = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 2, catalog: orderingCatalog });
    const atThree = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 3, catalog: orderingCatalog });
    const atFour = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 4, catalog: orderingCatalog });
    expect(atTwo.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue']);
    expect(atThree.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue', 'green']);
    expect(atFour.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue', 'green', 'magenta']);
    const names = (draft: ReturnType<typeof convertRasterToPattern>) => new Set(draft.document.palette.map((entry) => entry.catalog?.sourceId));
    expect([...names(atThree)].filter((name) => !names(atTwo).has(name))).toEqual(['green']);
    expect([...names(atTwo)].filter((name) => !names(atThree).has(name))).toEqual([]);
    expect([...names(atFour)].filter((name) => !names(atThree).has(name))).toEqual(['magenta']);
    expect([...names(atThree)].filter((name) => !names(atFour).has(name))).toEqual([]);
  });

  it('applies the same usage ordering on the async path', async () => {
    const source = raster(8, 1, orderedPixels);
    const options = { targetWidth: 8, targetHeight: 1, paletteBudget: 4, catalog: orderingCatalog };
    const synchronous = convertRasterToPattern(source, options);
    const asynchronous = await convertRasterToPatternAsync(source, options);
    expect(asynchronous.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(synchronous.document.palette.map((entry) => entry.catalog?.sourceId));
    expect(asynchronous.sourceImage.traceVisible).toBe(false);
  });

  it('skips a background source color before selection so it drops out of the palette and usage', () => {
    const source = raster(8, 1, orderedPixels);
    const without = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog });
    expect(without.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'blue', 'green', 'magenta']);
    const withBackground = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog, backgroundSourceId: 'blue' });
    expect(withBackground.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'green', 'magenta']);
    expect(withBackground.stats.paletteUsage.map((entry) => entry.catalogId)).not.toContain('blue');
    // Blue pixels are never counted, so shrinking the budget can never bring
    // the background color back; the UI-level auto-clear keys off this absence.
    const overShrunk = convertRasterToPattern(source, { targetWidth: 8, targetHeight: 1, paletteBudget: 3, catalog: orderingCatalog, backgroundSourceId: 'blue' });
    expect(overShrunk.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red', 'green', 'magenta']);
  });

  it('skips pixels whose matched palette color is the background in the assignment pass too', () => {
    // White pixels are skipped before selection, so white is not in the
    // palette and pure-white pixels stay unstitched in both passes.
    const source = raster(2, 1, [255, 255, 255, 255, 10, 20, 30, 255]);
    const draft = convertRasterToPattern(source, { targetWidth: 2, targetHeight: 1, paletteBudget: 3, catalog, backgroundSourceId: 'white' });
    expect(draft.document.kind[0]).toBe(CellKind.Empty);
    expect(draft.stats.emptyPixels).toBe(1);
    expect(draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['black']);
  });

  it('ignores unknown and non-string backgroundSourceId values', () => {
    const source = raster(8, 1, orderedPixels);
    const options = { targetWidth: 8, targetHeight: 1, paletteBudget: 6, catalog: orderingCatalog };
    const plain = convertRasterToPattern(source, options);
    const unknown = convertRasterToPattern(source, { ...options, backgroundSourceId: 'not-a-source-id' });
    const nonString = convertRasterToPattern(source, { ...options, backgroundSourceId: 42 as unknown as string });
    expect(unknown.document.palette).toEqual(plain.document.palette);
    expect(nonString.document.palette).toEqual(plain.document.palette);
  });

  it('skips pixels matching the selected background color, including pure white', () => {
    const source = raster(2, 1, [255, 255, 255, 255, 255, 0, 0, 255]);
    // Selecting white as the background leaves a pure-white pixel unstitched
    // while the red pixel still stitches.
    const whiteBackground = convertRasterToPattern(source, { targetWidth: 2, targetHeight: 1, paletteBudget: 3, catalog, backgroundSourceId: 'white' });
    expect(whiteBackground.document.kind).toEqual(new Uint8Array([CellKind.Empty, CellKind.Full]));
    expect(whiteBackground.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    // Selecting red as the background skips the red pixel; the white pixel
    // stays white in the palette.
    const redBackground = convertRasterToPattern(source, { targetWidth: 2, targetHeight: 1, paletteBudget: 3, catalog, backgroundSourceId: 'red' });
    expect(redBackground.document.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Empty]));
    expect(redBackground.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['white']);
  });

  it('keeps async worker/fallback mapping byte-for-byte equivalent to synchronous mapping', async () => {
    const input = raster(3, 2, [
      10, 20, 30, 255, 255, 0, 0, 255, 0, 0, 0, 0,
      0, 255, 0, 255, 255, 255, 255, 255, 20, 30, 40, 255
    ]);
    const options = { targetWidth: 4, targetHeight: 3, paletteBudget: 4, catalog, token: { projectId: 'p', baseRevision: 1, requestId: 'parity' } };
    const synchronous = convertRasterToPattern(input, options);
    const asynchronous = await convertRasterToPatternAsync(input, options);
    expect(asynchronous.document.kind).toEqual(synchronous.document.kind);
    expect(asynchronous.document.colors).toEqual(synchronous.document.colors);
    expect(asynchronous.document.palette).toEqual(synchronous.document.palette);
    expect(asynchronous.stats).toEqual(synchronous.stats);
  });

  it('cooperatively cancels inside a long resampling loop', async () => {
    const source = raster(2, 2, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
    let checks = 0;
    await expect(resampleRasterAsync(source, 500, 500, { isCancelled: () => {
      checks += 1;
      return checks > 3;
    } })).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(checks).toBeGreaterThan(3);
  });
});

const CROP_PIXELS: Record<string, readonly [number, number, number, number]> = {
  W: [255, 255, 255, 255],
  T: [0, 0, 0, 0],
  R: [255, 0, 0, 255],
  B: [0, 0, 255, 255]
};

function letterRaster(rows: readonly string[]): ConversionRaster {
  const pixels: number[] = [];
  for (const row of rows) for (const letter of row) pixels.push(...CROP_PIXELS[letter]);
  return raster(rows[0].length, rows.length, pixels);
}

describe('auto-crop to content', () => {
  it('trims transparent border cells from the pattern', () => {
    const input = letterRaster(['TTTT', 'TRRT', 'TRRT', 'TTTT']);
    const plain = convertRasterToPattern(input, { targetWidth: 4, targetHeight: 4, catalog });
    expect(plain.document.width).toBe(4);
    expect(plain.document.height).toBe(4);
    const cropped = convertRasterToPattern(input, { targetWidth: 4, targetHeight: 4, autoCrop: true, catalog });
    expect(cropped.document.width).toBe(2);
    expect(cropped.document.height).toBe(2);
    expect(cropped.document.kind).toEqual(new Uint8Array([CellKind.Full, CellKind.Full, CellKind.Full, CellKind.Full]));
    expect(Array.from(cropped.document.colors)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(cropped.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    // Stats describe the final document: transparency is re-scoped to the
    // kept box, keeping the draft validation invariants intact.
    expect(cropped.stats.transparentPixels).toBe(0);
    expect(cropped.stats.emptyPixels).toBe(0);
    expect(() => acceptConversionDraft(cropped)).not.toThrow();
  });

  it('trims background-selected margins and leaves white margins stitched', () => {
    const blueBorder = letterRaster(['BBBB', 'BRRB', 'BRRB', 'BBBB']);
    // Without the selection the blue border stitches, so nothing trims.
    const kept = convertRasterToPattern(blueBorder, { targetWidth: 4, targetHeight: 4, autoCrop: true, catalog });
    expect(kept.document.width).toBe(4);
    expect(kept.document.height).toBe(4);
    expect(kept.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['blue', 'red']);
    // With the selection the blue border stays empty and trims away.
    const cropped = convertRasterToPattern(blueBorder, { targetWidth: 4, targetHeight: 4, autoCrop: true, backgroundSourceId: 'blue', catalog });
    expect(cropped.document.width).toBe(2);
    expect(cropped.document.height).toBe(2);
    expect(cropped.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    // White has no pipeline skip, so a white border stitches and never trims.
    const whiteBorder = letterRaster(['WWWW', 'WRRW', 'WRRW', 'WWWW']);
    const whiteKept = convertRasterToPattern(whiteBorder, { targetWidth: 4, targetHeight: 4, autoCrop: true, catalog });
    expect(whiteKept.document.width).toBe(4);
    expect(whiteKept.document.height).toBe(4);
    expect(whiteKept.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['white', 'red']);
  });

  it('keeps original source dims and falls back on fully-empty patterns', () => {
    const input = letterRaster(['TTTT', 'TRRT', 'TRRT', 'TTTT']);
    const cropped = convertRasterToPattern(input, { targetWidth: 4, targetHeight: 4, autoCrop: true, catalog });
    expect(cropped.stats.sourceWidth).toBe(4);
    expect(cropped.stats.sourceHeight).toBe(4);
    expect(cropped.stats.stitchedPixels).toBe(4);
    expect(cropped.stats.emptyPixels).toBe(0);
    const empty = convertRasterToPattern(letterRaster(['TT', 'TT']), { targetWidth: 2, targetHeight: 2, autoCrop: true, catalog });
    expect(empty.document.width).toBe(2);
    expect(empty.document.height).toBe(2);
    expect(empty.document.palette).toEqual([]);
    expect(() => acceptConversionDraft(empty)).not.toThrow();
  });

  it('preserves backstitch-only edge cells when trimming a document', () => {
    const document = createDocument({ width: 4, height: 4, palette: [{ id: 1, name: 'Red', color: '#FF0000' }] });
    document.kind[1 * 4 + 1] = CellKind.Full;
    document.colors[(1 * 4 + 1) * 4] = 1;
    document.backstitches.ids = new Uint32Array([7]);
    document.backstitches.x1 = new Uint32Array([12]);
    document.backstitches.y1 = new Uint32Array([4]);
    document.backstitches.x2 = new Uint32Array([12]);
    document.backstitches.y2 = new Uint32Array([8]);
    document.backstitches.colors = new Uint16Array([1]);
    document.backstitches.completed = new Uint8Array([0]);
    document.nextBackstitchId = 8;
    // Stitch at (1,1); the segment spans quarter coords x=12, y=4..8, i.e.
    // column 3, rows 1..2 — a backstitch-only column the trim must keep.
    expect(trimDocumentToContent(document)).toEqual({ left: 1, top: 1, right: 3, bottom: 2 });
    expect(document.width).toBe(3);
    expect(document.height).toBe(2);
    expect(document.kind[0]).toBe(CellKind.Full);
    expect(document.colors[0]).toBe(1);
    expect(document.backstitches.ids[0]).toBe(7);
    expect(document.backstitches.x1[0]).toBe(8);
    expect(document.backstitches.y1[0]).toBe(0);
    expect(document.backstitches.x2[0]).toBe(8);
    expect(document.backstitches.y2[0]).toBe(4);
  });

  it('leaves full and fully-empty documents untouched', () => {
    const full = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#FF0000' }] });
    full.kind.fill(CellKind.Full);
    expect(trimDocumentToContent(full)).toBeNull();
    expect(full.width).toBe(2);
    expect(full.height).toBe(2);
    const empty = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#FF0000' }] });
    expect(trimDocumentToContent(empty)).toBeNull();
    expect(empty.width).toBe(2);
    expect(empty.height).toBe(2);
  });

  it('trims identically on the async path', async () => {
    const input = letterRaster(['TTTT', 'TRRT', 'TRRT', 'TTTT']);
    const options = { targetWidth: 4, targetHeight: 4, autoCrop: true, catalog };
    const synchronous = convertRasterToPattern(input, options);
    const asynchronous = await convertRasterToPatternAsync(input, options);
    expect(asynchronous.document.width).toBe(2);
    expect(asynchronous.document.height).toBe(2);
    expect(asynchronous.stats.sourceWidth).toBe(4);
    expect(asynchronous.stats.sourceHeight).toBe(4);
    expect(asynchronous.document.kind).toEqual(synchronous.document.kind);
    expect(asynchronous.document.colors).toEqual(synchronous.document.colors);
    expect(asynchronous.document.palette).toEqual(synchronous.document.palette);
    expect(asynchronous.stats).toEqual(synchronous.stats);
  });

  it('carries autoCrop through the request builders', () => {
    const source = new Blob(['x'], { type: 'image/png' });
    const withFlag = createConversionImageRequest({ source, targetWidth: 2, targetHeight: 2, autoCrop: true });
    expect(withFlag.autoCrop).toBe(true);
    const withoutFlag = createConversionRequest(raster(1, 1, [1, 2, 3, 255]), { targetWidth: 1, targetHeight: 1 });
    expect(withoutFlag.autoCrop).toBeUndefined();
  });
});

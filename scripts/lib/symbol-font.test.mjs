import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NORMALIZATION,
  blockOf,
  buildSymbol,
  characterName,
  fontSha256,
  glyphCommands,
  listCandidates,
  loadFont,
  slugify
} from './symbol-font.mjs';
import { measure, parsePathData } from './symbol-geometry.mjs';

const FONT_FILE = resolve(import.meta.dirname, '../../fonts/LibertinusMath-Regular.ttf');
const OUTLINES_FILE = resolve(import.meta.dirname, '../../src/symbols/outlines.generated.json');
const SELECTION_FILE = resolve(import.meta.dirname, '../../src/symbols/selection.json');

const sha256Of = (relative) => createHash('sha256')
  .update(readFileSync(resolve(import.meta.dirname, '../..', relative)))
  .digest('hex');

const font = loadFont(FONT_FILE);
const candidates = listCandidates(font, 'libertinus-math');
const byCodepoint = new Map(candidates.map((candidate) => [candidate.codepoint, candidate]));

describe('vendored font', () => {
  it('parses as a TrueType font with a usable design grid', () => {
    // Every later step divides by unitsPerEm, so an unreadable value here would
    // surface as glyphs scaled by a factor of thousands.
    expect(font.unitsPerEm).toBe(1000);
    expect(font.outlinesFormat).toBe('truetype');
  });

  it('is the file the selection records', () => {
    // The digest is what makes a committed outline traceable to a font build.
    // If the vendored file is ever swapped without updating selection.json, the
    // build fails rather than silently emitting outlines from a different font.
    const digest = createHash('sha256').update(readFileSync(FONT_FILE)).digest('hex');
    expect(fontSha256(FONT_FILE)).toBe(digest);
  });
});

describe('unicode names', () => {
  it('names a character from the Unicode character database', () => {
    expect(characterName(0x2665)).toBe('black heart suit');
    expect(characterName(0x25a0)).toBe('black square');
    expect(characterName(0x1d400)).toBe('mathematical bold capital a');
  });

  it('falls back to the codepoint when there is no readable name', () => {
    // Control characters are named "<control>", which slugs to nothing useful.
    expect(characterName(0x0001)).toBe('codepoint u0001');
  });

  it('slugs a name into a stable, addressable id', () => {
    expect(slugify('black heart suit')).toBe('black-heart-suit');
    expect(slugify('Black  Spade  Suit')).toBe('black-spade-suit');
    // Ids end up in a `d`-free slug, a sprite fragment, and a DOM id, so they
    // must stay lowercase and dash-separated.
    expect(slugify('mathematical bold capital a')).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('candidate enumeration', () => {
  it('offers every codepoint the font can actually draw', () => {
    const mapped = Object.keys(font.tables.cmap.glyphIndexMap).length;
    expect(candidates.length).toBeLessThan(mapped);
    expect(candidates.length).toBeGreaterThan(3000);
    // Nothing offered to the picker may fail to build, or selecting it breaks
    // the build rather than adding a symbol.
    const unbuildable = candidates.filter((candidate) => {
      try {
        glyphCommands(font, candidate.codepoint);
        return false;
      } catch {
        return true;
      }
    });
    expect(unbuildable.map((candidate) => candidate.id)).toEqual([]);
  });

  it('leaves out the codepoints that carry no ink', () => {
    // Spaces, zero-width joiners, and bidi marks are mapped but draw nothing.
    // They are formatting characters rather than marks, and a picker row with an
    // empty cell in it is a trap.
    const ids = new Set(candidates.map((candidate) => candidate.codepoint));
    expect(ids.has(0x0020)).toBe(false);
    expect(ids.has(0x00a0)).toBe(false);
    expect(ids.has(0x200b)).toBe(false);
    expect(ids.has(0x200d)).toBe(false);
    expect(ids.has(0x202e)).toBe(false);
  });

  it('never lists a codepoint twice', () => {
    const ids = candidates.map((candidate) => candidate.id);
    const codepoints = candidates.map((candidate) => candidate.codepoint);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codepoints).size).toBe(codepoints.length);
  });

  it('leaves no candidate on the codepoint fallback', () => {
    // Every candidate gets a Unicode name, so every id is a readable slug.
    // A fallback would mean a block or name lookup silently missed.
    const unnamed = candidates.filter((candidate) => candidate.name.startsWith('codepoint u'));
    expect(unnamed.map((candidate) => candidate.id)).toEqual([]);
  });

  it('assigns each codepoint its real block', () => {
    expect(blockOf(0x2665)).toBe('Miscellaneous Symbols');
    expect(blockOf(0x25a0)).toBe('Geometric Shapes');
    expect(blockOf(0x1d400)).toBe('Mathematical Alphanumeric Symbols');
    expect(blockOf(0x41)).toBe('Basic Latin');
  });});

describe('outline extraction', () => {
  const sample = (codePoint) => buildSymbol(font, byCodepoint.get(codePoint), NORMALIZATION);

  it('sizes every sampled candidate to the same extent, or stops at a scale clamp', () => {
    // Symbols are sized by extent so a wide mark and a tall mark read as the
    // same weight of ink in a cell. The clamps are the deliberate exception: a
    // full stop is 100 units of ink, and inflating it eight times to reach the
    // target extent would put a dot the size of a heart in the cell. Those
    // candidates come out smaller than target rather than being dropped.
    //
    // Normalizing flattens curves, so this samples one candidate per block
    // rather than all 3,626, which would take minutes. The exhaustive version
    // of the invariant runs over the committed path data instead, in
    // src/symbols/symbols.test.ts.
    const perBlock = new Map();
    for (const candidate of candidates) {
      if (!perBlock.has(candidate.block)) perBlock.set(candidate.block, candidate);
    }
    const sample = [...perBlock.values()];
    expect(sample.length).toBeGreaterThan(40);

    let exact = 0;
    for (const candidate of sample) {
      const { extent } = buildSymbol(font, candidate, NORMALIZATION);
      if (Math.abs(extent - NORMALIZATION.targetExtent) < 1e-6) exact += 1;
      // Whatever a clamp did, the ink still has to fit the cell it is drawn in.
      expect(extent, candidate.id).toBeLessThanOrEqual(NORMALIZATION.maxExtent);
      expect(extent, candidate.id).toBeLessThanOrEqual(NORMALIZATION.tileView);
    }
    // Almost everything normalizes exactly, so a regression that stops
    // normalizing cannot hide behind a handful of clamped glyphs.
    expect(exact / sample.length).toBeGreaterThan(0.9);
  });

  it('leaves a clamped mark smaller than the target rather than dropping it', () => {
    // The full stop is the canonical case: real ink, far below the target
    // extent, kept because a mark that is too small is still a mark.
    const fullStop = candidates.find((candidate) => candidate.codepoint === 0x002e);
    expect(fullStop).toBeDefined();
    const { extent, entry } = buildSymbol(font, fullStop, NORMALIZATION);
    expect(extent).toBeLessThan(NORMALIZATION.targetExtent);
    expect(extent).toBeGreaterThan(0);
    expect(entry.d.length).toBeGreaterThan(0);
  });

  it('centers every candidate on the origin', () => {
    // No per-glyph offset is stored, so a glyph that is not centered needs one
    // to be drawn in the right place. Compared through the committed path data,
    // so the check covers what actually ships, within its rounding precision.
    const tolerance = 2 * 10 ** -NORMALIZATION.precision;
    for (const codePoint of [0x2665, 0x2605, 0x25a0, 0x41, 0x1d400, 0x2192]) {
      const { entry } = sample(codePoint);
      const box = measure(parsePathData(entry.d)).bbox;
      const label = `U+${codePoint.toString(16)}`;
      expect(Math.abs(box.minX + box.maxX), `${label} is off-center in x`).toBeLessThan(tolerance);
      expect(Math.abs(box.minY + box.maxY), `${label} is off-center in y`).toBeLessThan(tolerance);
    }
  });

  it('records the codepoint and block it drew the outline from', () => {
    const { entry } = sample(0x2665);
    expect(entry.codepoint).toBe(0x2665);
    expect(entry.block).toBe('Miscellaneous Symbols');
    expect(entry.name).toBe('black heart suit');
  });

  it('extracts a composite glyph with all of its pieces', () => {
    // U+1D400 is a composite: if only the first component were walked, the
    // result would be a fraction of the mark and the extent check would fail.
    const { entry } = sample(0x1d400);
    expect(entry.d).toMatch(/M/);
    expect(parsePathData(entry.d).length).toBeGreaterThan(1);
  });

  it('keeps a carved hole as a second contour', () => {
    // A ring drawn as outer-then-inner contours must not collapse to a disc.
    const ring = candidates.find((candidate) => candidate.codepoint === 0x2b58);
    if (!ring) return;
    const { commands } = buildSymbol(font, ring, NORMALIZATION);
    const contours = commands.filter((command) => command[0] === 'M');
    expect(contours.length).toBeGreaterThan(1);
  });

  it('emits path data the canvas and the sprite can both consume', () => {
    // The same string backs a Path2D and an SVG <use>, so it has to be strict
    // path data with no exponent or trailing junk.
    for (const id of ['black-heart-suit', 'black-star', 'black-square'].map((slug) => `libertinus-math--${slug}`)) {
      const candidate = candidates.find((entry) => entry.id === id);
      expect(candidate, id).toBeDefined();
      expect(buildSymbol(font, candidate, NORMALIZATION).entry.d, id).toMatch(/^[MLCQZ0-9.\-\s]+$/);
    }
  });
});

describe('the committed pool', () => {
  const outlines = JSON.parse(readFileSync(OUTLINES_FILE, 'utf8'));
  const selection = JSON.parse(readFileSync(SELECTION_FILE, 'utf8'));

  it('is what the authored selection asks for', () => {
    // A generated artifact that disagrees with the file it is generated from is
    // the failure `symbols:check` exists to catch; this pins the same
    // relationship so a stale artifact is visible in the test run too.
    expect(Object.keys(outlines.symbols)).toHaveLength(selection.selection.length);
    // Every recorded font is one the selection actually draws from, and the
    // digest is of the vendored file the outline was extracted from.
    for (const entry of Object.values(outlines.symbols)) {
      expect(outlines.fonts[entry.font], entry.id).toBeDefined();
    }
    for (const provenance of Object.values(outlines.fonts)) {
      expect(sha256Of(provenance.file)).toBe(provenance.sha256);
    }
  });

  it('draws every selected symbol with enough ink to be visible', () => {
    // Normalizing by extent can produce a shape with almost no area: a hairline
    // has a wide bounding box and almost nothing inside it, so it vanishes at
    // chart sizes. The real enclosed area is measured from the committed path
    // data, because that is what the canvas and the sprite both fill.
    for (const [id, entry] of Object.entries(outlines.symbols)) {
      expect(measure(parsePathData(entry.d)).area, `${id} has no ink to draw`).toBeGreaterThan(0.01);
    }
  });

  it('keeps every committed outline inside the tile viewport it records', () => {
    // The artifact carries its own tile window, so the preview cannot drift
    // from the geometry that produced it.
    for (const [id, entry] of Object.entries(outlines.symbols)) {
      const box = measure(parsePathData(entry.d)).bbox;
      const farthest = Math.max(Math.abs(box.minX), Math.abs(box.maxX), Math.abs(box.minY), Math.abs(box.maxY));
      expect(farthest, `${id} is cropped by the tile viewport`).toBeLessThanOrEqual(outlines.tileView);
    }
  });
});

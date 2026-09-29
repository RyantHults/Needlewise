/**
 * Read symbols out of the vendored fonts.
 *
 * A codepoint can only be selected if the font has contours for it, so this
 * module owns the whole pipeline: glyph commands, the Unicode name and block,
 * the normalized outline, and the id a palette entry stores. A glyph the font
 * maps but cannot draw is not a candidate at all, which is why the candidate
 * list is shorter than the cmap. Every function that touches a font takes the
 * parsed font and its slug, so nothing here can read as belonging to one
 * implicit font.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * - Labels come from the Unicode character name, never from the font's own
 *   `post` table. Libertinus Math mixes AGL names with synthesized `uniXXXX`
 *   ones, so `glyph.name` is `heart` for U+2665 but `uni2605` for U+2605 and
 *   `filledbox` for U+25A0. The Unicode name is stable, unique per codepoint,
 *   and human-readable for all three.
 * - Glyph outlines arrive in font units (unitsPerEm 1000) and are rescaled to
 *   cell units on the way in. `normalizeOutline` clamps its scale factor to
 *   [minScale, maxScale], and those bounds are calibrated for outlines that
 *   already sit near one cell unit wide. Without the rescale, a 648-unit glyph
 *   asks for a 0.0006 scale, gets clamped up to minScale, and overflows the cell
 *   by two orders of magnitude.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import opentype from 'opentype.js';
import names from '@unicode/unicode-15.1.0/Names/index.mjs';

import { normalizeOutline, scale, toPathData } from './symbol-geometry.mjs';

const require = createRequire(import.meta.url);

/**
 * The shared unit cell and how a glyph is fitted into it.
 *
 * Extents are normalized to the target so one mark reads at the same visual
 * weight as the next, with a ceiling and a floor on the scale factor: a glyph
 * that is mostly whitespace must not be inflated to fill the cell, and the clamp
 * on the low side deliberately leaves a mark like a full stop smaller than the
 * target rather than distorting it. A glyph contour is already a filled
 * silhouette, so nothing is stroked and no stroke width is kept clear of the
 * tile edge.
 *
 * `tileView` is the half-extent the picker and sprite windows must show, kept
 * here so the runtime cannot disagree with the geometry that produced it.
 */
export const NORMALIZATION = Object.freeze({
  targetExtent: 0.4,
  maxExtent: 0.48,
  minScale: 0.2,
  maxScale: 4,
  precision: 3,
  tileView: 0.5
});

/** Parse a font. The path is required, so no caller can quietly get one font. */
export function loadFont(path) {
  if (!path) throw new Error('loadFont needs the path of the font to read.');
  return opentype.parse(readFileSync(path));
}

export function fontSha256(path) {
  if (!path) throw new Error('fontSha256 needs the path of the font to digest.');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The Unicode name of a codepoint, cleaned for display.
 *
 * Control and private-use characters have angle-bracketed placeholder names
 * that read as markup; they are replaced with a hex label so every label is
 * presentable. No such codepoint is in the pool today, but the candidate list
 * spans the whole cmap and the picker shows all of it.
 */
export function characterName(codePoint) {
  const raw = names.get(codePoint);
  if (typeof raw !== 'string' || raw.length === 0) return hexLabel(codePoint);
  if (raw.startsWith('<')) return hexLabel(codePoint);
  return raw.toLowerCase().replace(/[‐-―]/g, '-');
}

const hexLabel = (codePoint) => `codepoint u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Every Unicode block name, keyed by codepoint.
 *
 * The package ships one module per block and thousands of them, so they are
 * resolved by filename through a dynamic import and the result is cached. That
 * walk costs a few hundred milliseconds, so {@link blockOf} builds the map on
 * first use rather than making every caller thread it through.
 */
export function buildBlockMap() {
  const blockRoot = dirname(dirname(require.resolve('@unicode/unicode-15.1.0/Block/Arrows/ranges.mjs')));
  const map = new Map();
  for (const entry of readdirSync(blockRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const label = entry.name.replace(/_/g, ' ');
    const ranges = require(resolve(blockRoot, entry.name, 'ranges.mjs'));
    for (const range of ranges.default ?? ranges) {
      for (const codePoint of range.keys()) map.set(codePoint, label);
    }
  }
  return map;
}

let cachedBlockMap = null;

/** The Unicode block a codepoint belongs to, building the block map on first use. */
export function blockOf(codePoint) {
  if (!cachedBlockMap) cachedBlockMap = buildBlockMap();
  return cachedBlockMap.get(codePoint) ?? 'Unassigned';
}

/** `BLACK HEART SUIT` -> `black-heart-suit`. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Assign a stable id to every candidate.
 *
 * The id is qualified by the font that draws the glyph, so two fonts can hold
 * the same codepoint without colliding. The font and the glyph are separated by
 * a double hyphen, which a font slug can never contain, so the boundary between
 * them is unambiguous. Within a font the codepoint is the identity; the slug is
 * a readable face of it that can be searched and stored in a saved document
 * without looking opaque. Unicode names are unique per codepoint, so a collision
 * can only come from slug folding two distinct names together, and the codepoint
 * suffix resolves that.
 */
export function assignIds(candidates) {
  const seen = new Map();
  const out = [];
  for (const candidate of candidates) {
    const base = slugify(candidate.name);
    const glyph = base.length > 0 ? base : `u${candidate.codepoint.toString(16).toLowerCase()}`;
    const stem = `${candidate.font}--${glyph}`;
    const used = seen.get(stem) ?? 0;
    seen.set(stem, used + 1);
    const id = used === 0 ? stem : `${stem}-u${candidate.codepoint.toString(16).toLowerCase()}`;
    out.push({ ...candidate, id });
  }
  return out;
}

/**
 * Every codepoint one font can draw, tagged with the font that draws it.
 *
 * opentype keys its cmap's `glyphIndexMap` by codepoint, which is the forward
 * map in the same shape opentype itself enumerates. A font's codepoints are
 * filtered to those that map to a real contour: a mapped codepoint can still be
 * undrawable, because index 0 is .notdef and a real glyph index can hold an
 * empty outline, and offering an undrawable glyph in the picker would only
 * produce a build failure on selection.
 *
 * The font slug is required so no caller can read these candidates as belonging
 * to a single implicit font.
 */
export function listCandidates(font, fontSlug) {
  const glyphIndexMap = font.tables.cmap?.glyphIndexMap ?? {};
  const candidates = [];
  for (const key of Object.keys(glyphIndexMap)) {
    const codepoint = Number(key);
    // A mapped codepoint can still be undrawable. Index 0 is .notdef, and even
    // a real glyph index can hold an empty outline: Libertinus Math maps the
    // spaces, the zero-width joiners, and the bidi marks to glyphs that have no
    // contours at all. Those are formatting characters, not marks, and offering
    // them in the picker would only produce a build failure on selection.
    if (glyphIndexMap[key] === 0) continue;
    if (!hasOutline(font, glyphIndexMap[key])) continue;
    candidates.push({
      font: fontSlug,
      codepoint,
      name: characterName(codepoint),
      block: blockOf(codepoint)
    });
  }
  candidates.sort((a, b) => a.codepoint - b.codepoint);
  return assignIds(candidates);
}

/**
 * Whether a glyph index has any contour to draw.
 *
 * Reading `glyph.path.commands` is the same parse `getPath` performs, minus the
 * transform, so this costs no more than the extraction that follows it.
 */
function hasOutline(font, glyphIndex) {
  const glyph = font.glyphs.get(glyphIndex);
  return Boolean(glyph?.path?.commands?.length);
}

/**
 * One glyph's outline in cell units, centered on the origin and unnormalized.
 *
 * `getPath` already flips to y-down, so the result is in SVG's coordinate space
 * and needs no further flip. TrueType contours open with a `moveTo` followed by
 * a `lineTo` of the same point; that redundant segment is dropped so the
 * committed path data does not carry one dead command per contour.
 */
export function glyphCommands(font, codePoint) {
  const glyph = font.charToGlyph(String.fromCodePoint(codePoint));
  if (!glyph) throw new Error(`U+${hex(codePoint)} is not in the font`);
  const path = glyph.getPath(0, 0, font.unitsPerEm);
  const commands = [];
  for (const command of path.commands) {
    if (command.type === 'Z') {
      commands.push(['Z']);
      continue;
    }
    const letter = command.type;
    const args = command.type === 'M' || command.type === 'L'
      ? [command.x, command.y]
      : command.type === 'Q'
        ? [command.x1, command.y1, command.x, command.y]
        : [command.x1, command.y1, command.x2, command.y2, command.x, command.y];
    const previous = commands[commands.length - 1];
    const isRedundantOpen = letter === 'L' && previous && previous[0] === 'M'
      && previous[1] === command.x && previous[2] === command.y;
    if (isRedundantOpen) continue;
    commands.push([letter, ...args]);
  }
  if (commands.length === 0) throw new Error(`U+${hex(codePoint)} has no outline`);
  return scale(commands, 1 / font.unitsPerEm);
}

const hex = (codePoint) => codePoint.toString(16).toUpperCase().padStart(4, '0');

/** Extract one selected codepoint all the way to committed path data. */
export function buildSymbol(font, candidate, normalization = NORMALIZATION) {
  const normalized = normalizeOutline(glyphCommands(font, candidate.codepoint), normalization);
  return {
    entry: {
      name: candidate.name,
      block: candidate.block,
      codepoint: candidate.codepoint,
      d: toPathData(normalized.commands, normalization.precision)
    },
    extent: normalized.extent,
    inkArea: normalized.inkArea
  };
}

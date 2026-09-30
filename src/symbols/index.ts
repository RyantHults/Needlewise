import outlinesAsset from './pool-asset';
import type { SymbolOutline } from '../rendering/symbol-painter';

/**
 * The owned symbol pool.
 *
 * `selection.json` is the authored source of truth: it lists one
 * `font:U+XXXX` entry per pooled glyph, and the pool holds whichever of them
 * the picker has ticked. `outlines.generated.json` is the committed build
 * output of that selection, produced by
 * `node scripts/build-symbol-outlines.mjs` and verified in CI with `--check`.
 * It records the provenance of every font the pool draws from, derived from the
 * font files at build time. Nothing is chosen at runtime and no glyph is ever
 * resolved from a system font. A selection can be empty, and then so is the
 * pool; the generated artifact is read through `./pool-asset`.
 *
 * Several fonts can draw the same codepoint, so a symbol is identified by its
 * font-qualified id and its Unicode name is unique only within one font.
 */
export interface PoolEntry {
  /** Stable slug, and the value a palette entry stores. */
  readonly id: string;
  /** Unicode character name, shown in the picker and used as the accessible label. */
  readonly name: string;
  /** Unicode block the glyph comes from, used to group and interleave the pool. */
  readonly block: string;
  /** The codepoint this outline was extracted from. */
  readonly codepoint: number;
  /** Slug of the font this outline was extracted from. */
  readonly font: string;
  /** Display name of that font, for attribution surfaces. */
  readonly family: string;
  /** SVG path data in the shared unit cell, centered on the origin. */
  readonly d: string;
}

export interface PoolFont {
  readonly family: string;
  readonly file: string;
  readonly sha256: string;
  readonly unitsPerEm: number;
  readonly version: string;
  readonly licenseUrl: string;
  readonly drawableCodepoints: number;
}

const asset = outlinesAsset as unknown as {
  readonly version: number;
  readonly fonts: Readonly<Record<string, PoolFont>>;
  readonly tileView: number;
  readonly generated: number;
  readonly symbols: Readonly<Record<string, PoolEntry>>;
};

/**
 * Half-extent, in cell units, of the tile viewport that previews a symbol.
 *
 * Outlines normalize to at most the pool's max extent, and the build emits the
 * preview window alongside them so the tile and the geometry that produced it
 * cannot drift apart. Kept as one constant so the tile and its sprite agree on
 * the same window; the runtime coverage test asserts no outline reaches the edge.
 */
export const SYMBOL_TILE_VIEW = asset.tileView;

/** Every font the pool was extracted from, keyed by slug, for attribution surfaces. */
export const SYMBOL_FONTS: Readonly<Record<string, PoolFont>> = asset.fonts;

const familyOf = (slug: string): string => SYMBOL_FONTS[slug]?.family ?? '';

export const SYMBOL_POOL_VERSION = asset.version;

export const SYMBOL_OUTLINES: Readonly<Record<string, PoolEntry>> = asset.symbols;

export const SYMBOL_IDS: readonly string[] = Object.keys(asset.symbols);

export const SYMBOL_COUNT = SYMBOL_IDS.length;

/**
 * Every symbol in the pool, ordered as the build emitted them and carrying its
 * own slug. The slug lives on the entry so a consumer listing the pool never has
 * to zip it back against {@link SYMBOL_IDS}.
 */
export const SYMBOL_POOL: readonly PoolEntry[] = SYMBOL_IDS.map((id) => {
  const entry = asset.symbols[id];
  return {
    id,
    name: entry.name,
    block: entry.block,
    codepoint: entry.codepoint,
    font: entry.font,
    family: familyOf(entry.font),
    d: entry.d
  };
});

/** Look up a symbol by slug. Returns undefined for an unknown or removed slug. */
export const getSymbolOutline = (slug: string): PoolEntry | undefined => SYMBOL_OUTLINES[slug];

/** Adapt a pool entry to the painter's outline shape. */
export const toSymbolOutline = (slug: string): SymbolOutline | undefined => {
  const entry = getSymbolOutline(slug);
  if (!entry) return undefined;
  return { d: entry.d };
};

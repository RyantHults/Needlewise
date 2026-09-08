/**
 * Symbol font sizing. The `em` size unit inside `RendererStyle.symbolFont` is
 * interpreted as a fraction of the grid cell rather than the browser's canvas
 * default 10px em, so the rendered glyph always scales with the cell rectangle
 * at every zoom level.
 */

export interface ParsedSymbolFont {
  weight: string;
  fraction: number;
  family: string;
}

/**
 * Parse the CSS font shorthand `weight size-unit family` into its parts.
 * Returns `undefined` whenever the size unit is not `em` (e.g. an already
 * absolute `px`/`pt` font) or the string is malformed, in which case the
 * caller must pass the font through unchanged.
 */
export function parseSymbolFont(symbolFont: string): ParsedSymbolFont | undefined {
  if (typeof symbolFont !== 'string') return undefined;
  const tokens = symbolFont.trim().split(/\s+/);
  if (tokens.length < 3) return undefined;
  const [weight, sizeToken, ...familyTokens] = tokens;
  if (weight.length === 0 || sizeToken.length === 0 || familyTokens.length === 0) return undefined;
  if (!sizeToken.endsWith('em')) return undefined;
  const fraction = Number.parseFloat(sizeToken.slice(0, -2));
  if (!Number.isFinite(fraction) || fraction < 0) return undefined;
  return { weight, fraction, family: familyTokens.join(' ') };
}

/**
 * Resolve a symbolic font (spanning `fraction` of the cell) into an absolute
 * pixel font for a cell of `cellSizePx` screen pixels. Non-`em` or malformed
 * inputs are returned unchanged. The pixel size is clamped to at least 1.
 */
export function symbolFontForCell(symbolFont: string, cellSizePx: number): string {
  const parsed = parseSymbolFont(symbolFont);
  if (parsed === undefined) return symbolFont;
  const rawPx = Math.round(cellSizePx * parsed.fraction);
  const px = Number.isFinite(rawPx) ? Math.max(1, rawPx) : 1;
  return `${parsed.weight} ${px}px ${parsed.family}`;
}

export interface SymbolRenderOverride {
  /**
   * Multiplied into the effective cell size used when resolving the symbol
   * font. Glyphs whose ink fills most of their em box (braille, block
   * elements, dense hatched squares, full-cell diagonals) render at a smaller
   * em so the ink stays inside the cell without touching neighbours.
   */
  scale?: number;
  /**
   * Vertical ink-bias correction in PIXELS, added to the draw centre y
   * (positive moves down). Used sparingly for keepers whose ink sits
   * slightly high or low in their em box.
   */
  dy?: number;
}

/**
 * Per-glyph render overrides for palette symbols. Judgments are conservative
 * cross-font estimates taken from Unicode/font metrics (DejaVu, Noto Sans
 * Symbols 2, Segoe UI Symbol, Apple fonts) — they remove gross overflow and
 * off-centre cases rather than pixel-perfecting any single raster. Every key
 * must be present in PALETTE_SYMBOLS (enforced by the override contract test).
 */
export const SYMBOL_RENDER_OVERRIDES: Readonly<Record<string, SymbolRenderOverride>> = {
  // Dense / full-cell ink: shrink the em so ink no longer touches the cell edge.
  '⣿': { scale: 0.6 }, // braille dots-12345678: tight 8-dot grid
  '⠿': { scale: 0.65 }, // braille dots-123456: tight 6-dot grid
  '░': { scale: 0.65 }, // 25% shade block
  '▒': { scale: 0.65 }, // 50% shade block
  '▛': { scale: 0.55 }, // 3/4-quadrant fill (kept in the tail)
  '⬚': { scale: 0.8 }, // full-cell dotted square
  '▣': { scale: 0.85 }, // square with orthogonal crosshatch
  '▩': { scale: 0.85 }, // square with diagonal crosshatch
  '▦': { scale: 0.85 }, // square with orthogonal hatch
  '▤': { scale: 0.85 }, // square with horizontal fill
  '▥': { scale: 0.85 }, // square with vertical fill
  '━': { scale: 0.85 }, // heavy horizontal box line
  '┃': { scale: 0.85 }, // heavy vertical box line
  '𝄞': { scale: 0.8 }, // G clef spans the em
  '╲': { scale: 0.85 }, // full-cell diagonal stroke
  '╱': { scale: 0.85 }, // full-cell diagonal stroke
  '╳': { scale: 0.85 }, // full-cell diagonal cross
  // Vertical ink bias in common symbol fonts (font-dependent estimate).
  '℗': { scale: 0.7, dy: 2 }
};

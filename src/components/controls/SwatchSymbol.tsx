import { DEFAULT_RENDERER_STYLE } from '../../editor/contracts';
import { contrastSymbolInk } from '../../rendering/contrast';
import { SYMBOL_TILE_VIEW } from '../../symbols';

/** The viewBox of every pool symbol: the sprite and each tile that `<use>`s it. */
export const SYMBOL_VIEWBOX = `${-SYMBOL_TILE_VIEW} ${-SYMBOL_TILE_VIEW} ${SYMBOL_TILE_VIEW * 2} ${SYMBOL_TILE_VIEW * 2}`;

/** The id of a pool symbol inside the sprite. */
export const symbolSpriteId = (slug: string): string => `symbol-${slug}`;

/**
 * One preview of a pool symbol, drawn from the single sprite path rather than
 * repeating its `d` string. The palette swatch, the symbol chip, the details
 * menu, and the picker grid go through here, so a mark is the same geometry
 * everywhere and one value is read, not copied.
 */
export const SymbolTile = ({ id, className = 'symbol-token' }: { id: string; className?: string }) => (
  <svg className={className} viewBox={SYMBOL_VIEWBOX} aria-hidden="true" focusable="false">
    <use href={`#${symbolSpriteId(id)}`} />
  </svg>
);

/** A symbol on a palette swatch, inked to contrast with the swatch color. */
export function SwatchSymbol({ symbol, color }: { symbol: string; color: string }) {
  return <span className="palette-swatch-symbol" style={{ color: contrastSymbolInk(color, DEFAULT_RENDERER_STYLE.symbolColor) }}><SymbolTile id={symbol} /></span>;
}

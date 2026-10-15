import { getDmcColor } from '../../catalog';
import type { SymbolMapping } from '../../import/types';

/** The `#rrggbb` a mapping resolves to: its catalog thread first, else its custom color. */
export function mappingColor(mapping: SymbolMapping | undefined): string | undefined {
  if (!mapping) return undefined;
  if (mapping.catalogCode) {
    const thread = getDmcColor(mapping.catalogCode);
    if (thread) return thread.hex;
  }
  return mapping.color;
}

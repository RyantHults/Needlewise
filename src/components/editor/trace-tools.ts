import { createCatalogReference, type CatalogDefinition, type CatalogRecord } from '../../catalog';
import type { TraceRgb } from '../../editor/contracts';

/** Pick a color from the supplied catalog definition, never an ad-hoc RGB value. */
export function nearestCatalogColor(definition: CatalogDefinition, rgb: TraceRgb): CatalogRecord | undefined {
  return definition.nearest(rgb);
}

export function catalogReference(definition: CatalogDefinition, color: CatalogRecord) {
  return createCatalogReference(definition, color);
}

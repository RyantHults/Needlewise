import { DMC_CATALOG, DMC_CATALOG_METADATA, type DmcCatalogColor } from '../../catalog';
import type { TraceRgb } from '../../editor/contracts';

/** Pick a catalog colour, never an ad-hoc RGB value. */
export function nearestDmcColor(rgb: TraceRgb): DmcCatalogColor {
  return DMC_CATALOG.reduce((nearest, candidate) => {
    const distance = candidate.rgb.reduce((sum, channel, index) => sum + (channel - [rgb.r, rgb.g, rgb.b][index]) ** 2, 0);
    const nearestDistance = nearest.rgb.reduce((sum, channel, index) => sum + (channel - [rgb.r, rgb.g, rgb.b][index]) ** 2, 0);
    return distance < nearestDistance ? candidate : nearest;
  });
}

export function catalogReference(color: DmcCatalogColor) {
  return { catalogId: DMC_CATALOG_METADATA.catalogId, sourceId: color.sourceId, code: color.code, name: color.name, hex: color.hex, rgb: [...color.rgb] as [number, number, number] };
}

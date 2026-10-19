import type { CatalogDefinition } from "../../catalog";
import type { PaletteEntry } from "../../domain";
import { normalizeHexColor } from "../../domain/color";

/**
 * The thread code a palette entry is shown by: its catalog code, else its hex.
 * `brand` is set only when another catalog in `palette` uses the same code.
 */
export function paletteCodeFor(
  entry: PaletteEntry,
  palette: readonly PaletteEntry[],
  catalogs: readonly CatalogDefinition[],
): { brand?: string; code: string; label: string } {
  const code = entry.catalog?.code ?? normalizeHexColor(entry.color) ?? entry.color;
  let brand: string | undefined;
  if (entry.catalog) {
    const catalogIds = new Set<string>();
    for (const other of palette) {
      if (other.catalog?.code === entry.catalog.code) catalogIds.add(other.catalog.catalogId);
    }
    if (catalogIds.size > 1) {
      const catalogId = entry.catalog.catalogId;
      brand = catalogs.find((item) => item.association.catalogId === catalogId)?.association.brandLabel;
    }
  }
  return { ...(brand ? { brand } : {}), code, label: brand ? `${brand} ${code}` : code };
}

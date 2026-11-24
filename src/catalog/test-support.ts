import { MaterialKind, MaterialUnit, type PaletteEntryInput } from '../domain/types';
import { createCatalogReference, INSTALLED_CATALOG_REGISTRY, type CatalogDefinition, type CatalogRecord } from './index';

export const makeCatalog = (catalogId: string, brandLabel: string, records: CatalogRecord[]): CatalogDefinition => {
  const byHex = new Map(records.map((record) => [record.hex.toUpperCase(), record]));
  return { association: { catalogId, brandLabel, colorCount: records.length }, records, compatibilityLabel: `${brandLabel}-compatible`, materialKind: MaterialKind.Floss, snapshot: { association: { catalogId, brandLabel, colorCount: records.length }, records }, search: (query, options = {}) => records.filter((record) => !query || `${record.name} ${record.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit), getByHex: (hex) => byHex.get(hex.toUpperCase()), nearest: () => records[0] };
};

/** The installed Mill Hill bead catalog, found in the registry the way the workspace lists bead catalogs. */
export function millHillCatalog(): CatalogDefinition {
  const definition = INSTALLED_CATALOG_REGISTRY.definitions.find((candidate) => candidate.materialKind === MaterialKind.Bead);
  if (definition === undefined) throw new Error('No bead catalog is installed.');
  return definition;
}

/** A palette entry for the real Mill Hill bead `code`, made the way the bead picker makes one. */
export function millHillBeadEntry(id: number, code = '00479'): PaletteEntryInput {
  const catalog = millHillCatalog();
  const record = catalog.records.find((candidate) => candidate.code === code);
  if (record === undefined) throw new Error(`Mill Hill has no bead ${code}.`);
  return {
    id,
    name: record.name,
    color: record.hex,
    material: { kind: MaterialKind.Bead, label: record.name, unit: MaterialUnit.Count },
    catalog: createCatalogReference(catalog, record)
  };
}

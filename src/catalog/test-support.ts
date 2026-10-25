import type { CatalogDefinition, CatalogRecord } from './index';

export const makeCatalog = (catalogId: string, brandLabel: string, records: CatalogRecord[]): CatalogDefinition => {
  const byHex = new Map(records.map((record) => [record.hex.toUpperCase(), record]));
  return { association: { catalogId, brandLabel, colorCount: records.length }, records, compatibilityLabel: `${brandLabel}-compatible`, snapshot: { association: { catalogId, brandLabel, colorCount: records.length }, records }, search: (query, options = {}) => records.filter((record) => !query || `${record.name} ${record.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit), getByHex: (hex) => byHex.get(hex.toUpperCase()), nearest: () => records[0] };
};

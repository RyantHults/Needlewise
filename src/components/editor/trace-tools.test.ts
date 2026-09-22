import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION, type CatalogDefinition, type CatalogRecord } from '../../catalog';
import { catalogReference, nearestCatalogColor } from './trace-tools';

describe('trace colour tools', () => {
  it('maps a sampled RGB value to the nearest offline catalog colour', () => {
    const color = nearestCatalogColor(DEFAULT_CATALOG_DEFINITION, { r: 0, g: 0, b: 0 })!;
    expect(color).toBeDefined();
    expect(color.hex).toBe('#000000');
    expect(catalogReference(DEFAULT_CATALOG_DEFINITION, color)).toMatchObject({ catalogId: 'dmc-compatible-screen-approximation', sourceId: color.sourceId, code: color.code });
  });

  it('accepts a synthetic catalog definition without depending on DMC globals', () => {
    const record: CatalogRecord = { sourceId: 'synthetic:scarlet', code: 'S1', name: 'Scarlet', hex: '#DD1122', rgb: [221, 17, 34] };
    const definition: CatalogDefinition = {
      association: { catalogId: 'synthetic-v1', brandLabel: 'Synthetic', colorCount: 1 },
      records: [record],
      compatibilityLabel: 'Synthetic',
      snapshot: {
        association: { catalogId: 'synthetic-v1', brandLabel: 'Synthetic', colorCount: 1 },
        records: [record]
      },
      search: () => [record],
      getByHex: () => record,
      nearest: () => record
    };

    expect(nearestCatalogColor(definition, { r: 1, g: 2, b: 3 })).toBe(record);
    expect(catalogReference(definition, record)).toEqual({
      catalogId: 'synthetic-v1',
      sourceId: 'synthetic:scarlet',
      code: 'S1',
      name: 'Scarlet',
      hex: '#DD1122',
      rgb: [221, 17, 34]
    });
  });
});

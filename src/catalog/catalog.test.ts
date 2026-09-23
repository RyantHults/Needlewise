import { describe, expect, it, vi } from 'vitest';
import {
  DMC_CATALOG_DEFINITION,
  DEFAULT_CATALOG_DEFINITION,
  DMC_CATALOG,
  DMC_CATALOG_IS_OFFLINE_ONLY,
  DMC_CATALOG_METADATA,
  DMC_CATALOG_PROVENANCE,
  DMC_CATALOG_RECORD_COUNT,
  createInstalledCatalogRegistry,
  createCatalogReference,
  getDmcColor,
  getDmcColorByHex,
  nearestDmcColor,
  resolveCatalogDefinition,
  searchDmcColors,
  validateDmcCatalog,
  validateDmcCatalogBundle,
  type CatalogDefinition,
  type DmcCatalogColor
} from './index';

function syntheticDefinition(catalogId: string, brandLabel: string): CatalogDefinition {
  const association = Object.freeze({ catalogId, brandLabel, colorCount: DMC_CATALOG_DEFINITION.records.length });
  return Object.freeze({
    ...DMC_CATALOG_DEFINITION,
    association,
    snapshot: Object.freeze({ association, records: DMC_CATALOG_DEFINITION.records })
  });
}

describe('offline DMC-compatible catalog', () => {
  const catalogAsset = {
    schemaVersion: 1,
    catalogId: DMC_CATALOG_METADATA.catalogId,
    records: DMC_CATALOG
  };

  it('resolves the DMC definition and performs generic search, exact hex, and nearest RGB lookup', () => {
    const definition = resolveCatalogDefinition(DMC_CATALOG_DEFINITION.association);
    expect(definition).toMatchObject({ association: DMC_CATALOG_DEFINITION.association, compatibilityLabel: DMC_CATALOG_DEFINITION.compatibilityLabel });
    expect(resolveCatalogDefinition(DMC_CATALOG_DEFINITION.association)).toBe(definition);
    expect(definition?.getByHex('#FFE2E2')?.code).toBe('3713');
    expect(definition?.search('salmon', { limit: 1 })).toHaveLength(1);
    expect(definition?.nearest({ r: 0, g: 0, b: 0 })?.code).toBe('310');
  });

  it('creates a serializable snapshot and matching palette reference', () => {
    const record = DMC_CATALOG_DEFINITION.records.at(0);
    expect(record).toBeDefined();
    expect(DMC_CATALOG_DEFINITION.snapshot).toEqual({
      association: DMC_CATALOG_DEFINITION.association,
      records: DMC_CATALOG_DEFINITION.records,
    });
    expect(createCatalogReference(DMC_CATALOG_DEFINITION, record!)).toMatchObject({
      catalogId: DMC_CATALOG_DEFINITION.association.catalogId,
      sourceId: record!.sourceId,
    });
  });

  it('resolves only the registered immutable catalog association', () => {
    expect(DEFAULT_CATALOG_DEFINITION).toBe(DMC_CATALOG_DEFINITION);
    const registered = resolveCatalogDefinition({ ...DMC_CATALOG_DEFINITION.association });
    expect(registered).toBeDefined();
    expect(resolveCatalogDefinition({ ...DMC_CATALOG_DEFINITION.association })).toBe(registered);
    expect(registered).toBe(DMC_CATALOG_DEFINITION);
    expect(resolveCatalogDefinition({ ...DMC_CATALOG_DEFINITION.association, catalogId: 'future-revision' })).toBeUndefined();
    expect(resolveCatalogDefinition({ ...DMC_CATALOG_DEFINITION.association, brandLabel: 'Other' })).toBeUndefined();
    expect(resolveCatalogDefinition({ ...DMC_CATALOG_DEFINITION.association, colorCount: 1 })).toBeUndefined();
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.association)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.snapshot)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records[0])).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records[0].rgb)).toBe(true);
  });

  it('creates an immutable installed-catalog registry with association and ID lookup', () => {
    const first = syntheticDefinition('catalog-a', 'Catalog A');
    const second = syntheticDefinition('catalog-b', 'Catalog B');
    const definitions = [first, second];
    const registry = createInstalledCatalogRegistry(definitions);
    definitions.pop();

    expect(registry.definitions.map((definition) => definition.association)).toEqual([first.association, second.association]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.definitions)).toBe(true);
    expect(registry.resolve(first.association)).toBe(registry.definitions[0]);
    expect(registry.definitions[0]).not.toBe(first);
    expect(registry.resolve({ ...first.association, brandLabel: 'Other' })).toBeUndefined();
    expect(registry.resolve({ ...first.association, colorCount: 1 })).toBeUndefined();
    expect(registry.getById('catalog-b')).toBe(registry.definitions[1]);
    expect(registry.getById('missing')).toBeUndefined();
    expect(() => (registry.definitions as CatalogDefinition[]).push(second)).toThrow();
  });

  it('snapshots caller-owned catalog data and methods when registering a definition', () => {
    const association = { catalogId: 'mutable-catalog', brandLabel: 'Mutable Catalog', colorCount: 1 };
    const record = { sourceId: 'mutable-1', code: '01', name: 'Original', hex: '#010203' as `#${string}`, rgb: [1, 2, 3] as [number, number, number] };
    const records = [record];
    const definition = {
      association,
      records,
      compatibilityLabel: 'Mutable',
      snapshot: { association, records },
      search: (query: string) => records.filter((candidate) => candidate.name.includes(query)),
      getByHex: (hex: string) => records.find((candidate) => candidate.hex === hex),
      nearest: () => records[0]
    } as CatalogDefinition;
    const registry = createInstalledCatalogRegistry([definition]);
    const registered = registry.getById('mutable-catalog')!;

    association.catalogId = 'changed-catalog';
    association.brandLabel = 'Changed Catalog';
    association.colorCount = 9;
    record.code = '99';
    record.name = 'Changed';
    record.hex = '#FFFFFF';
    record.rgb[0] = 255;
    records.splice(0, 1);

    expect(registry.resolve({ catalogId: 'mutable-catalog', brandLabel: 'Mutable Catalog', colorCount: 1 })).toBe(registered);
    expect(registry.getById('mutable-catalog')).toBe(registered);
    expect(registry.getById('changed-catalog')).toBeUndefined();
    expect(registered).not.toBe(definition);
    expect(registered.association).toEqual({ catalogId: 'mutable-catalog', brandLabel: 'Mutable Catalog', colorCount: 1 });
    expect(registered.records).toEqual([{ sourceId: 'mutable-1', code: '01', name: 'Original', hex: '#010203', rgb: [1, 2, 3] }]);
    expect(registered.snapshot.association).toBe(registered.association);
    expect(registered.snapshot.records).toBe(registered.records);
    expect(registered.search('Original')).toEqual(registered.records);
    expect(registered.getByHex('#010203')).toBe(registered.records[0]);
    expect(registered.nearest({ r: 1, g: 2, b: 3 })).toBe(registered.records[0]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.association)).toBe(true);
    expect(Object.isFrozen(registered.snapshot)).toBe(true);
    expect(Object.isFrozen(registered.records)).toBe(true);
    expect(Object.isFrozen(registered.records[0])).toBe(true);
    expect(Object.isFrozen(registered.records[0].rgb)).toBe(true);
  });

  it('rejects duplicate installed catalog IDs', () => {
    const first = syntheticDefinition('duplicate-id', 'Catalog A');
    const second = syntheticDefinition('duplicate-id', 'Catalog B');

    expect(() => createInstalledCatalogRegistry([first, second])).toThrow(/duplicate.*catalog ID/i);
  });

  it('contains a validated, unique normalized dataset', () => {
    const validation = validateDmcCatalog(DMC_CATALOG);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(DMC_CATALOG_RECORD_COUNT).toBe(489);
    expect(DMC_CATALOG_DEFINITION.association.colorCount).toBe(DMC_CATALOG_DEFINITION.records.length);
    expect(DMC_CATALOG_DEFINITION.records.length).toBe(DMC_CATALOG_RECORD_COUNT);
    expect(new Set(DMC_CATALOG.map((record) => record.sourceId)).size).toBe(DMC_CATALOG.length);
    expect(new Set(DMC_CATALOG.map((record) => record.code.toUpperCase())).size).toBe(DMC_CATALOG.length);
    expect(new Set(DMC_CATALOG.map((record) => record.hex)).size).toBe(DMC_CATALOG.length);
    expect(DMC_CATALOG.every((record) => record.hex === `#${record.rgb.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`)).toBe(true);
  });

  it('reports malformed and duplicate records instead of accepting them', () => {
    const malformed = DMC_CATALOG.map((record) => ({ ...record })) as DmcCatalogColor[];
    malformed[0] = { ...malformed[0], hex: '#000000', rgb: [255, 226, 226] };
    const invalid = validateDmcCatalog(malformed);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes('HEX/RGB'))).toBe(true);

    const duplicate = validateDmcCatalog([...DMC_CATALOG, DMC_CATALOG[0]]);
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.some((error) => error.includes('duplicates a code'))).toBe(true);
    expect(duplicate.errors.some((error) => error.includes('duplicates a source ID'))).toBe(true);
    expect(duplicate.errors.some((error) => error.includes('duplicates a HEX value'))).toBe(true);
  });

  it('validates the exact catalog schema and required provenance status', () => {
    expect(validateDmcCatalogBundle().valid).toBe(true);
    const malformedCatalog = { ...catalogAsset, schemaVersion: 2 };
    const catalogSchema = validateDmcCatalogBundle(malformedCatalog, DMC_CATALOG_PROVENANCE);
    expect(catalogSchema.valid).toBe(false);
    expect(catalogSchema.errors.some((error) => error.includes('catalog.schemaVersion'))).toBe(true);

    const malformedProvenance = {
      ...DMC_CATALOG_PROVENANCE,
      status: { ...DMC_CATALOG_PROVENANCE.status, official: true, approximation: false, unresolvedUpstreamRightsWarning: '' }
    };
    const provenanceSchema = validateDmcCatalogBundle(catalogAsset, malformedProvenance);
    expect(provenanceSchema.valid).toBe(false);
    expect(provenanceSchema.errors.some((error) => error.includes('official must be false'))).toBe(true);
    expect(provenanceSchema.errors.some((error) => error.includes('approximation must be true'))).toBe(true);
    expect(provenanceSchema.errors.some((error) => error.includes('unresolvedUpstreamRightsWarning'))).toBe(true);
  });

  it('binds provenance catalog count, ID, and SHA-256 to the committed asset', () => {
    const countMismatch = {
      ...DMC_CATALOG_PROVENANCE,
      snapshot: { ...DMC_CATALOG_PROVENANCE.snapshot, observedDmcRecordCount: 488 }
    };
    const countResult = validateDmcCatalogBundle(catalogAsset, countMismatch);
    expect(countResult.valid).toBe(false);
    expect(countResult.errors.some((error) => error.includes('observed record count'))).toBe(true);

    const changedRecords = DMC_CATALOG.map((record, index) => index === 0 ? { ...record, name: 'Changed source row' } : record);
    const changedCatalog = { ...catalogAsset, records: changedRecords };
    const hashResult = validateDmcCatalogBundle(changedCatalog, DMC_CATALOG_PROVENANCE);
    expect(hashResult.valid).toBe(false);
    expect(hashResult.errors.some((error) => error.includes('normalizedCatalogSha256'))).toBe(true);

    const idMismatch = { ...DMC_CATALOG_PROVENANCE, catalogId: 'other-catalog' };
    const idResult = validateDmcCatalogBundle(catalogAsset, idMismatch);
    expect(idResult.valid).toBe(false);
    expect(idResult.errors.some((error) => error.includes('catalogId'))).toBe(true);
  });

  it('supports stable code lookup and deterministic text search', () => {
    expect(getDmcColor('3713')).toMatchObject({ sourceId: 'dmc-3713', name: 'Salmon Very Light', hex: '#FFE2E2' });
    expect(getDmcColor('dmc-09')).toMatchObject({ sourceId: 'dmc-09', code: '09' });
    expect(getDmcColor('B5200')).toMatchObject({ sourceId: 'dmc-B5200' });
    expect(getDmcColor('Ecru')).toMatchObject({ sourceId: 'dmc-ECRU' });
    expect(getDmcColor(3713)?.code).toBe('3713');
    expect(getDmcColor('missing')).toBeUndefined();
    expect(DMC_CATALOG_DEFINITION.getByHex('#ffe2e2')).toMatchObject({
      code: '3713',
      hex: '#FFE2E2',
    });
    expect(getDmcColorByHex('#ffe2e2')).toBe(DMC_CATALOG_DEFINITION.getByHex('#ffe2e2'));
    expect(getDmcColorByHex('#FFFFFF')).toMatchObject({
      code: 'B5200',
      hex: '#FFFFFF',
    });
    for (const record of DMC_CATALOG) {
      expect(DMC_CATALOG_DEFINITION.getByHex(record.hex)).toBe(record);
      expect(DMC_CATALOG_DEFINITION.getByHex(record.hex.toLowerCase())).toBe(record);
      expect(getDmcColorByHex(record.hex)).toBe(record);
      expect(getDmcColorByHex(record.hex.toLowerCase())).toBe(record);
    }
    expect(getDmcColorByHex('#010203')).toBeUndefined();
    expect(getDmcColorByHex('#GGGGGG')).toBeUndefined();
    expect(getDmcColorByHex('#FFF')).toBeUndefined();

    const salmon = DMC_CATALOG_DEFINITION.search('salmon');
    expect(salmon.length).toBeGreaterThan(1);
    expect(salmon[0].name).toContain('Salmon');
    expect(DMC_CATALOG_DEFINITION.search('#FFE2E2')).toHaveLength(1);
    expect(DMC_CATALOG_DEFINITION.search('DMC-09')).toHaveLength(1);
    expect(DMC_CATALOG_DEFINITION.search('', { limit: 3 })).toHaveLength(3);
    expect(searchDmcColors('salmon')).toEqual(salmon);
  });

  it('exposes approximation provenance and never calls network APIs', () => {
    expect(DMC_CATALOG_IS_OFFLINE_ONLY).toBe(true);
    expect(DMC_CATALOG_METADATA.approximation).toBe(true);
    expect(DMC_CATALOG_METADATA.official).toBe(false);
    expect(DMC_CATALOG_METADATA.dmcAffiliation).toBe(false);
    expect(DMC_CATALOG_PROVENANCE.source.upstreamDataUrl).toBe('https://floss.maxxmint.com/dmc_to_rgb.php');
    expect(DMC_CATALOG_PROVENANCE.snapshot.htmlSha256).toBe('80b8cf1994d160836f1cb0cea8c6f49963707ee02a56a42a11ba640c94d9c086');
    expect(DMC_CATALOG_PROVENANCE.snapshot.observedDmcRecordCount).toBe(489);

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
    try {
      expect(getDmcColor('3713')?.hex).toBe('#FFE2E2');
      expect(searchDmcColors('salmon').length).toBeGreaterThan(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('matches an RGB sample to the closest catalog color by squared Euclidean distance', () => {
    const exact = getDmcColor('3713');
    const nearest = DMC_CATALOG_DEFINITION.nearest({ r: 255, g: 226, b: 226 });
    expect(nearest?.code).toBe(exact!.code);
    expect(nearestDmcColor({ r: 255, g: 226, b: 226 })).toBe(nearest);

    const white = DMC_CATALOG_DEFINITION.nearest({ r: 255, g: 255, b: 255 });
    expect(white).toBeDefined();
    expect(white!.rgb).toEqual([255, 255, 255]);

    const black = DMC_CATALOG_DEFINITION.nearest({ r: 0, g: 0, b: 0 });
    expect(black).toBeDefined();
    expect(Math.min(...black!.rgb)).toBeLessThan(40);
  });
});

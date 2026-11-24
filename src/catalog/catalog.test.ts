import { describe, expect, it } from 'vitest';
import { millHillCatalog } from './test-support';
import provenanceAsset from '../../catalog/provenance.json';
import millHillAsset from '../../catalog/mill-hill-beads.json';
import millHillProvenanceAsset from '../../catalog/mill-hill-provenance.json';
import { MaterialKind } from '../domain/types';
import { validateMillHillCatalogBundle } from './mill-hill';
import {
  DMC_CATALOG_DEFINITION,
  DEFAULT_CATALOG_DEFINITION,
  DMC_CATALOG,
  DMC_CATALOG_RECORD_COUNT,
  INSTALLED_CATALOG_REGISTRY,
  SEED_BEAD_SIZE_MM,
  beadSizeMm,
  createCatalogReference,
  getDmcColor,
  validateDmcCatalogBundle,
  type DmcCatalogColor,
  type DmcCatalogProvenance
} from './index';

const DMC_CATALOG_PROVENANCE = provenanceAsset as unknown as DmcCatalogProvenance;

describe('offline DMC-compatible catalog', () => {
  const catalogAsset = {
    schemaVersion: 1,
    catalogId: DMC_CATALOG_DEFINITION.association.catalogId,
    records: DMC_CATALOG
  };

  it('resolves the DMC definition and performs generic search, exact hex, and nearest RGB lookup', () => {
    const definition = INSTALLED_CATALOG_REGISTRY.resolve(DMC_CATALOG_DEFINITION.association);
    expect(definition).toMatchObject({ association: DMC_CATALOG_DEFINITION.association, compatibilityLabel: DMC_CATALOG_DEFINITION.compatibilityLabel });
    expect(INSTALLED_CATALOG_REGISTRY.resolve(DMC_CATALOG_DEFINITION.association)).toBe(definition);
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
    const registered = INSTALLED_CATALOG_REGISTRY.resolve({ ...DMC_CATALOG_DEFINITION.association });
    expect(registered).toBeDefined();
    expect(INSTALLED_CATALOG_REGISTRY.resolve({ ...DMC_CATALOG_DEFINITION.association })).toBe(registered);
    expect(registered).toBe(INSTALLED_CATALOG_REGISTRY.definitions.find((definition) => definition.association.catalogId === DMC_CATALOG_DEFINITION.association.catalogId));
    expect(registered?.association).toEqual(DMC_CATALOG_DEFINITION.association);
    expect(registered?.records).toEqual(DMC_CATALOG_DEFINITION.records);
    expect(INSTALLED_CATALOG_REGISTRY.resolve({ ...DMC_CATALOG_DEFINITION.association, catalogId: 'future-revision' })).toBeUndefined();
    expect(INSTALLED_CATALOG_REGISTRY.resolve({ ...DMC_CATALOG_DEFINITION.association, brandLabel: 'Other' })).toBeUndefined();
    expect(INSTALLED_CATALOG_REGISTRY.resolve({ ...DMC_CATALOG_DEFINITION.association, colorCount: 1 })).toBeUndefined();
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.association)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.snapshot)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records)).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records[0])).toBe(true);
    expect(Object.isFrozen(DMC_CATALOG_DEFINITION.records[0].rgb)).toBe(true);
  });

  it('contains a validated, unique normalized dataset', () => {
    const validation = validateDmcCatalogBundle(catalogAsset, DMC_CATALOG_PROVENANCE);
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
    const invalid = validateDmcCatalogBundle({ ...catalogAsset, records: malformed }, DMC_CATALOG_PROVENANCE);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes('HEX/RGB'))).toBe(true);

    const duplicate = validateDmcCatalogBundle({ ...catalogAsset, records: [...DMC_CATALOG, DMC_CATALOG[0]] }, DMC_CATALOG_PROVENANCE);
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
    expect(getDmcColor('Blanc')).toMatchObject({ sourceId: 'dmc-BLANC', code: 'Blanc', name: 'Blanc', hex: '#FCFBF8' });
    expect(getDmcColor('White')).toBe(getDmcColor('Blanc'));
    expect(getDmcColor('dmc-WHITE')).toBe(getDmcColor('Blanc'));
    expect(getDmcColor('B5200')).toMatchObject({ name: 'Snow White' });
    expect(getDmcColor(3713)?.code).toBe('3713');
    expect(getDmcColor('missing')).toBeUndefined();
    expect(DMC_CATALOG_DEFINITION.getByHex('#ffe2e2')).toMatchObject({
      code: '3713',
      hex: '#FFE2E2',
    });
    expect(DMC_CATALOG_DEFINITION.getByHex('#FFFFFF')).toMatchObject({
      code: 'B5200',
      hex: '#FFFFFF',
    });
    for (const record of DMC_CATALOG) {
      expect(DMC_CATALOG_DEFINITION.getByHex(record.hex)).toBe(record);
      expect(DMC_CATALOG_DEFINITION.getByHex(record.hex.toLowerCase())).toBe(record);
    }
    expect(DMC_CATALOG_DEFINITION.getByHex('#010203')).toBeUndefined();
    expect(DMC_CATALOG_DEFINITION.getByHex('#GGGGGG')).toBeUndefined();
    expect(DMC_CATALOG_DEFINITION.getByHex('#FFF')).toBeUndefined();

    const salmon = DMC_CATALOG_DEFINITION.search('salmon');
    expect(salmon.length).toBeGreaterThan(1);
    expect(salmon[0].name).toContain('Salmon');
    expect(DMC_CATALOG_DEFINITION.search('#FFE2E2')).toHaveLength(1);
    expect(DMC_CATALOG_DEFINITION.search('DMC-09')).toHaveLength(1);
    expect(DMC_CATALOG_DEFINITION.search('', { limit: 3 })).toHaveLength(3);
  });

  it('exposes approximation provenance', () => {
    expect(DMC_CATALOG_PROVENANCE.status.approximation).toBe(true);
    expect(DMC_CATALOG_PROVENANCE.status.official).toBe(false);
    expect(DMC_CATALOG_PROVENANCE.status.dmcAffiliation).toBe(false);
  });

  it('matches an RGB sample to the closest catalog color by squared Euclidean distance', () => {
    const exact = getDmcColor('3713');
    const nearest = DMC_CATALOG_DEFINITION.nearest({ r: 255, g: 226, b: 226 });
    expect(nearest?.code).toBe(exact!.code);

    const white = DMC_CATALOG_DEFINITION.nearest({ r: 255, g: 255, b: 255 });
    expect(white).toBeDefined();
    expect(white!.rgb).toEqual([255, 255, 255]);

    const black = DMC_CATALOG_DEFINITION.nearest({ r: 0, g: 0, b: 0 });
    expect(black).toBeDefined();
    expect(Math.min(...black!.rgb)).toBeLessThan(40);
  });
});

describe('Mill Hill bead catalog', () => {
  const beadRecords = millHillAsset.records;

  it('validates the committed bundle against the DMC catalog it was mapped from', () => {
    const validation = validateMillHillCatalogBundle(millHillAsset, millHillProvenanceAsset, DMC_CATALOG);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('is installed as a bead catalog beside the DMC thread catalog', () => {
    expect(INSTALLED_CATALOG_REGISTRY.resolve(millHillCatalog().association)).toBe(millHillCatalog());
    expect(millHillCatalog().materialKind).toBe(MaterialKind.Bead);
    expect(DMC_CATALOG_DEFINITION.materialKind).toBe(MaterialKind.Floss);
    expect(millHillCatalog().association.colorCount).toBe(beadRecords.length);
  });

  it('colours each bead with its mapped DMC thread and lets beads share a colour', () => {
    const blanc = getDmcColor('Blanc')!;
    const whiteBeads = millHillCatalog().records.filter((record) => record.hex === blanc.hex);
    expect(whiteBeads.length).toBeGreaterThan(1);
    expect(millHillCatalog().getByHex(blanc.hex.toLowerCase())).toBe(whiteBeads[0]);
    expect(millHillCatalog().search('00479')).toEqual([expect.objectContaining({ code: '00479', sourceId: 'mill-hill-00479', hex: blanc.hex })]);
    expect(millHillCatalog().nearest({ r: blanc.rgb[0], g: blanc.rgb[1], b: blanc.rgb[2] })?.hex).toBe(blanc.hex);
  });

  it('gives every bead a positive diameter and length and resolves an entry to its bead size', () => {
    for (const record of beadRecords) {
      expect(record.diameterMm).toBeGreaterThan(0);
      expect(record.lengthMm).toBeGreaterThan(0);
    }
    const reference = (code: string) => {
      const record = millHillCatalog().records.find((candidate) => candidate.code === code)!;
      return { catalog: createCatalogReference(millHillCatalog(), record) };
    };
    expect(beadSizeMm(reference('00479'))).toEqual({ diameterMm: 2.5, lengthMm: 1.75 });
    expect(beadSizeMm(reference('05002'))).toEqual({ diameterMm: 5.5, lengthMm: 3.85 });
    expect(beadSizeMm({ catalog: { ...reference('00479').catalog, sourceId: 'mill-hill-99999' } })).toBe(SEED_BEAD_SIZE_MM);
  });

  it('rejects a bead whose colour differs from its DMC record', () => {
    const records = beadRecords.map((record, index) => index === 0 ? { ...record, hex: '#010203', rgb: [1, 2, 3] } : record);
    const result = validateMillHillCatalogBundle({ ...millHillAsset, records }, millHillProvenanceAsset, DMC_CATALOG);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('does not match its DMC record'))).toBe(true);
  });

  it('rejects a bead mapped to a DMC code the catalog lacks', () => {
    const records = beadRecords.map((record, index) => index === 0 ? { ...record, dmcCode: 'missing' } : record);
    const result = validateMillHillCatalogBundle({ ...millHillAsset, records }, millHillProvenanceAsset, DMC_CATALOG);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('dmcCode'))).toBe(true);
  });

  it('rejects duplicate bead codes', () => {
    const result = validateMillHillCatalogBundle({ ...millHillAsset, records: [...beadRecords, beadRecords[0]] }, millHillProvenanceAsset, DMC_CATALOG);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('duplicates a code'))).toBe(true);
    expect(result.errors.some((error) => error.includes('duplicates a source ID'))).toBe(true);
  });

  it('binds provenance to the catalog and requires the approximation status', () => {
    const renamed = beadRecords.map((record, index) => index === 0 ? { ...record, name: 'Changed' } : record);
    const hashResult = validateMillHillCatalogBundle({ ...millHillAsset, records: renamed }, millHillProvenanceAsset, DMC_CATALOG);
    expect(hashResult.errors.some((error) => error.includes('normalizedCatalogSha256'))).toBe(true);

    const official = { ...millHillProvenanceAsset, status: { ...millHillProvenanceAsset.status, official: true, millHillAffiliation: true } };
    const statusResult = validateMillHillCatalogBundle(millHillAsset, official, DMC_CATALOG);
    expect(statusResult.errors.some((error) => error.includes('official must be false'))).toBe(true);
    expect(statusResult.errors.some((error) => error.includes('millHillAffiliation must be false'))).toBe(true);
  });
});

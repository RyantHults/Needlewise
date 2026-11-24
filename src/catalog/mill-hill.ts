import beadAsset from '../../catalog/mill-hill-beads.json';
import provenanceAsset from '../../catalog/mill-hill-provenance.json';
import { MaterialKind } from '../domain/types';
import { isRecord } from '../domain/guards';
import { createCatalogDefinition, expectedRgb, hasExactKeys, isRgb, isSha256, sha256, stableJson } from './catalog-asset';
import type { CatalogDefinition, CatalogRecord } from './index';

/** A Mill Hill bead, coloured by the DMC thread the official conversion chart maps it to. */
export interface MillHillBead extends CatalogRecord {
  readonly series: string;
  readonly dmcCode: string;
  /** The bead's diameter in millimetres, from its series. */
  readonly diameterMm: number;
  /** The bead's length along its hole in millimetres, from its series. */
  readonly lengthMm: number;
}

/** The Mill Hill definition, whose records keep their bead fields. */
export type MillHillCatalogDefinition = Omit<CatalogDefinition, 'records'> & { readonly records: readonly MillHillBead[] };

export interface MillHillCatalogValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

interface MillHillAsset {
  readonly schemaVersion: number;
  readonly catalogId: string;
  readonly records: readonly {
    readonly sourceId: string;
    readonly code: string;
    readonly name: string;
    readonly series: string;
    readonly dmcCode: string;
    readonly diameterMm: number;
    readonly lengthMm: number;
    readonly hex: string;
    readonly rgb: readonly number[];
  }[];
}

const EXPECTED_SCHEMA_VERSION = 1;
const EXPECTED_CATALOG_ID = 'mill-hill-dmc-mapped-approximation';
const EXPECTED_SOURCE_URL = 'http://www.millhillbeads.com/images/bead_to_dmc_conversion.pdf';
const RECORD_KEYS = ['sourceId', 'code', 'name', 'series', 'dmcCode', 'diameterMm', 'lengthMm', 'hex', 'rgb'];

function validateRecords(records: unknown, dmcByCode: ReadonlyMap<string, CatalogRecord>, errors: string[]): void {
  if (!Array.isArray(records) || records.length === 0) {
    errors.push('catalog.records must be a non-empty array.');
    return;
  }
  const codes = new Set<string>();
  const sourceIds = new Set<string>();
  for (const [index, candidate] of records.entries()) {
    const path = `catalog.records[${String(index)}]`;
    if (!hasExactKeys(candidate, RECORD_KEYS, path, errors)) continue;
    const { code, sourceId, name, series, dmcCode, hex } = candidate;
    if (typeof code !== 'string' || !/^\d{5}$/.test(code)) errors.push(`${path}.code must be a five-digit bead code.`);
    if (typeof name !== 'string' || !name.trim()) errors.push(`${path}.name must be non-empty.`);
    if (typeof series !== 'string' || !series.trim()) errors.push(`${path}.series must be non-empty.`);
    if (typeof candidate.diameterMm !== 'number' || !Number.isFinite(candidate.diameterMm) || candidate.diameterMm <= 0) errors.push(`${path}.diameterMm must be a positive number of millimetres.`);
    if (typeof candidate.lengthMm !== 'number' || !Number.isFinite(candidate.lengthMm) || candidate.lengthMm <= 0) errors.push(`${path}.lengthMm must be a positive number of millimetres.`);
    if (sourceId !== `mill-hill-${typeof code === 'string' ? code : ''}`) errors.push(`${path}.sourceId must be mill-hill-{code}.`);
    const rgb = typeof hex === 'string' ? expectedRgb(hex) : undefined;
    if (!rgb) errors.push(`${path}.hex must be an uppercase six-digit HEX value.`);
    if (!isRgb(candidate.rgb)) errors.push(`${path}.rgb must contain three bytes.`);
    else if (rgb && candidate.rgb.some((value, channel) => value !== rgb[channel])) errors.push(`${path} has an inconsistent HEX/RGB pair.`);
    const dmc = typeof dmcCode === 'string' ? dmcByCode.get(dmcCode) : undefined;
    if (!dmc) errors.push(`${path}.dmcCode does not name a DMC catalog record.`);
    else if (dmc.hex !== hex) errors.push(`${path}.hex does not match its DMC record.`);
    if (typeof code === 'string' && codes.has(code)) errors.push(`${path} duplicates a code.`);
    if (typeof sourceId === 'string' && sourceIds.has(sourceId)) errors.push(`${path} duplicates a source ID.`);
    if (typeof code === 'string') codes.add(code);
    if (typeof sourceId === 'string') sourceIds.add(sourceId);
  }
}

function validateProvenance(value: unknown, errors: string[]): void {
  if (!hasExactKeys(value, ['schemaVersion', 'catalogId', 'source', 'snapshot', 'beadSizes', 'extraction', 'status'], 'provenance', errors)) return;
  if (value.schemaVersion !== EXPECTED_SCHEMA_VERSION) errors.push('provenance.schemaVersion is unsupported.');
  if (value.catalogId !== EXPECTED_CATALOG_ID) errors.push('provenance.catalogId does not identify this catalog.');
  if (hasExactKeys(value.source, ['url', 'title', 'publisher', 'documentDate', 'pdfSha256', 'retrievedAt', 'transcription', 'transcriptionMethod', 'runtimePolicy'], 'provenance.source', errors)) {
    if (value.source.url !== EXPECTED_SOURCE_URL) errors.push('provenance.source.url is unexpected.');
    if (!isSha256(value.source.pdfSha256)) errors.push('provenance.source.pdfSha256 must be a lowercase SHA-256 digest.');
    if (typeof value.source.runtimePolicy !== 'string' || !value.source.runtimePolicy.includes('never fetches')) errors.push('provenance.source.runtimePolicy must document offline runtime behavior.');
  }
  if (hasExactKeys(value.snapshot, ['transcribedRowCount', 'recordCount', 'seriesCounts', 'normalizedCatalogSha256'], 'provenance.snapshot', errors)) {
    if (!isSha256(value.snapshot.normalizedCatalogSha256)) errors.push('provenance.snapshot.normalizedCatalogSha256 must be a lowercase SHA-256 digest.');
  }
  if (hasExactKeys(value.extraction, ['builder', 'rules'], 'provenance.extraction', errors)) {
    if (value.extraction.builder !== 'scripts/build-mill-hill-catalog.mjs') errors.push('provenance.extraction.builder is unexpected.');
  }
  if (hasExactKeys(value.status, ['official', 'approximation', 'description', 'millHillAffiliation', 'unresolvedUpstreamRightsWarning'], 'provenance.status', errors)) {
    if (value.status.official !== false) errors.push('provenance.status.official must be false.');
    if (value.status.approximation !== true) errors.push('provenance.status.approximation must be true.');
    if (value.status.millHillAffiliation !== false) errors.push('provenance.status.millHillAffiliation must be false.');
    if (typeof value.status.unresolvedUpstreamRightsWarning !== 'string' || !value.status.unresolvedUpstreamRightsWarning.trim()) errors.push('provenance.status.unresolvedUpstreamRightsWarning is required.');
  }
}

/**
 * Validate a Mill Hill bundle against the DMC catalog it was mapped from.
 * Unlike DMC, beads may share a HEX value: several beads map to one thread.
 */
export function validateMillHillCatalogBundle(catalogInput: unknown, provenanceInput: unknown, dmcRecords: readonly CatalogRecord[]): MillHillCatalogValidation {
  const errors: string[] = [];
  const dmcByCode = new Map(dmcRecords.map((record) => [record.code, record]));
  if (hasExactKeys(catalogInput, ['schemaVersion', 'catalogId', 'records'], 'catalog', errors)) {
    if (catalogInput.schemaVersion !== EXPECTED_SCHEMA_VERSION) errors.push('catalog.schemaVersion is unsupported.');
    if (catalogInput.catalogId !== EXPECTED_CATALOG_ID) errors.push('catalog.catalogId is unexpected.');
    validateRecords(catalogInput.records, dmcByCode, errors);
  }
  validateProvenance(provenanceInput, errors);
  if (isRecord(catalogInput) && isRecord(provenanceInput) && isRecord(provenanceInput.snapshot) && Array.isArray(catalogInput.records)) {
    if (provenanceInput.snapshot.recordCount !== catalogInput.records.length) errors.push('provenance record count does not match the catalog.');
    const serialized = stableJson(catalogInput);
    if (serialized && provenanceInput.snapshot.normalizedCatalogSha256 !== sha256(serialized)) errors.push('provenance normalizedCatalogSha256 does not match the catalog asset.');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Validate the committed bundle against `dmcRecords` and build its catalog definition. */
export function createMillHillCatalogDefinition(dmcRecords: readonly CatalogRecord[]): MillHillCatalogDefinition {
  const validation = validateMillHillCatalogBundle(beadAsset, provenanceAsset, dmcRecords);
  if (!validation.valid) throw new Error(`Invalid committed Mill Hill catalog bundle: ${validation.errors.join(' ')}`);
  const asset = beadAsset as MillHillAsset;
  const records: readonly MillHillBead[] = Object.freeze(asset.records.map((record) => Object.freeze({
    sourceId: record.sourceId,
    code: record.code,
    name: record.name,
    series: record.series,
    dmcCode: record.dmcCode,
    diameterMm: record.diameterMm,
    lengthMm: record.lengthMm,
    hex: record.hex as `#${string}`,
    rgb: Object.freeze([record.rgb[0], record.rgb[1], record.rgb[2]]) as readonly [number, number, number]
  })));
  // The definition holds exactly `records`, so its records are bead records.
  return createCatalogDefinition(
    { catalogId: asset.catalogId, brandLabel: 'Mill Hill', colorCount: records.length },
    records,
    'Mill Hill-compatible',
    MaterialKind.Bead,
  ) as MillHillCatalogDefinition;
}

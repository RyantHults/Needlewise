import catalogAsset from '../../catalog/dmc-colors.json';
import provenanceAsset from '../../catalog/provenance.json';
import { MaterialKind, type CatalogAssociation, type PaletteCatalogReference, type PaletteEntry } from '../domain/types';
import { isRecord } from '../domain/guards';
import { createCatalogDefinition, expectedRgb, hasExactKeys, isRgb, isSha256, sha256, stableJson } from './catalog-asset';
import { createMillHillCatalogDefinition } from './mill-hill';

export interface CatalogRecord {
  readonly sourceId: string;
  readonly code: string;
  readonly name: string;
  readonly hex: `#${string}`;
  readonly rgb: readonly [number, number, number];
}

export type DmcCatalogColor = CatalogRecord;

export interface CatalogSnapshot {
  readonly association: CatalogAssociation;
  readonly records: readonly CatalogRecord[];
}

export interface CatalogDefinition extends CatalogSnapshot {
  readonly compatibilityLabel: string;
  /** What a palette entry made from this catalog is: thread or bead. */
  readonly materialKind: MaterialKind;
  readonly snapshot: CatalogSnapshot;
  search(query: string, options?: { readonly limit?: number }): readonly CatalogRecord[];
  getByHex(hex: string): CatalogRecord | undefined;
  nearest(rgb: { readonly r: number; readonly g: number; readonly b: number }): CatalogRecord | undefined;
}

export interface DmcCatalogProvenance {
  readonly schemaVersion: number;
  readonly catalogId: string;
  readonly source: {
    readonly repository: string;
    readonly repositoryTree: string;
    readonly repositoryLicense: string;
    readonly inspectedTreeSha: string;
    readonly upstreamDataUrl: string;
    readonly runtimePolicy: string;
  };
  readonly snapshot: {
    readonly retrievedAt: string;
    readonly htmlSha256: string;
    readonly dataSha256: string;
    readonly normalizedCatalogSha256: string;
    readonly observedHtmlTableRows: number;
    readonly observedDmcRecordCount: number;
    readonly sourceRgbMismatchCount: number;
    readonly sourceRgbMismatches: readonly {
      readonly code: string;
      readonly sourceRgb: readonly [number, number, number];
      readonly hexRgb: readonly [number, number, number];
    }[];
  };
  readonly extraction: {
    readonly parser: string;
    readonly rules: readonly string[];
    readonly validation: string;
  };
  readonly status: {
    readonly official: boolean;
    readonly approximation: boolean;
    readonly description: string;
    readonly dmcAffiliation: boolean;
    readonly unresolvedUpstreamRightsWarning: string;
  };
}

export interface DmcCatalogValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

interface CatalogRecordAsset {
  readonly sourceId: string;
  readonly code: string;
  readonly name: string;
  readonly hex: string;
  readonly rgb: readonly number[];
}

interface CatalogAsset {
  readonly schemaVersion: number;
  readonly catalogId: string;
  readonly records: readonly CatalogRecordAsset[];
}

const rawCatalog = catalogAsset as CatalogAsset;
const rawProvenance = provenanceAsset as unknown as DmcCatalogProvenance;

const EXPECTED_CATALOG_SCHEMA_VERSION = 1;
const EXPECTED_CATALOG_ID = 'dmc-compatible-screen-approximation';
const EXPECTED_RECORD_COUNT = 489;
const EXPECTED_HTML_ROW_COUNT = 502;
const EXPECTED_REPOSITORY = 'https://github.com/syke99/go-c2dmc';
const EXPECTED_REPOSITORY_TREE = 'https://github.com/syke99/go-c2dmc/tree/1474067bf9c75a4acc15990eb086846f23e025b5';
const EXPECTED_REPOSITORY_SHA = '1474067bf9c75a4acc15990eb086846f23e025b5';
const EXPECTED_UPSTREAM_URL = 'https://floss.maxxmint.com/dmc_to_rgb.php';

function validateRecordList(records: unknown, errors: string[], path: string): records is readonly DmcCatalogColor[] {
  if (!Array.isArray(records)) {
    errors.push(`${path} must be an array.`);
    return false;
  }
  if (records.length !== EXPECTED_RECORD_COUNT) errors.push(`${path} must contain exactly ${String(EXPECTED_RECORD_COUNT)} records; found ${String(records.length)}.`);
  const codes = new Set<string>();
  const sourceIds = new Set<string>();
  const hexes = new Set<string>();
  for (const [index, candidate] of records.entries()) {
    const recordPath = `${path}[${String(index)}]`;
    if (!hasExactKeys(candidate, ['sourceId', 'code', 'name', 'hex', 'rgb'], recordPath, errors)) continue;
    const code = candidate.code;
    const sourceId = candidate.sourceId;
    const name = candidate.name;
    const hex = candidate.hex;
    if (typeof code !== 'string' || !/^[0-9A-Za-z]+$/.test(code)) errors.push(`${recordPath}.code must be alphanumeric.`);
    if (typeof name !== 'string' || !name.trim()) errors.push(`${recordPath}.name must be non-empty.`);
    if (typeof sourceId !== 'string' || sourceId !== `dmc-${typeof code === 'string' ? code.toUpperCase() : ''}`) errors.push(`${recordPath}.sourceId must be dmc-{CODE}.`);
    const rgb = typeof hex === 'string' ? expectedRgb(hex) : undefined;
    if (!rgb) errors.push(`${recordPath}.hex must be an uppercase six-digit HEX value.`);
    if (!isRgb(candidate.rgb)) errors.push(`${recordPath}.rgb must contain three bytes.`);
    else if (rgb && candidate.rgb.some((value, channel) => value !== rgb[channel])) errors.push(`${recordPath} has an inconsistent HEX/RGB pair.`);
    const normalizedCode = typeof code === 'string' ? code.toUpperCase() : '';
    if (codes.has(normalizedCode)) errors.push(`${recordPath} duplicates a code.`);
    if (typeof sourceId === 'string' && sourceIds.has(sourceId)) errors.push(`${recordPath} duplicates a source ID.`);
    if (typeof hex === 'string' && hexes.has(hex)) errors.push(`${recordPath} duplicates a HEX value.`);
    codes.add(normalizedCode);
    if (typeof sourceId === 'string') sourceIds.add(sourceId);
    if (typeof hex === 'string') hexes.add(hex);
  }
  return errors.length === 0;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateProvenance(value: unknown, errors: string[]): value is DmcCatalogProvenance {
  if (!hasExactKeys(value, ['schemaVersion', 'catalogId', 'source', 'snapshot', 'extraction', 'status'], 'provenance', errors)) return false;
  if (value.schemaVersion !== EXPECTED_CATALOG_SCHEMA_VERSION) errors.push('provenance.schemaVersion is unsupported.');
  if (value.catalogId !== EXPECTED_CATALOG_ID) errors.push('provenance.catalogId does not identify this catalog.');

  if (hasExactKeys(value.source, ['repository', 'repositoryTree', 'repositoryLicense', 'inspectedTreeSha', 'upstreamDataUrl', 'runtimePolicy'], 'provenance.source', errors)) {
    if (value.source.repository !== EXPECTED_REPOSITORY) errors.push('provenance.source.repository is unexpected.');
    if (value.source.repositoryTree !== EXPECTED_REPOSITORY_TREE) errors.push('provenance.source.repositoryTree is unexpected.');
    if (value.source.repositoryLicense !== 'MIT') errors.push('provenance.source.repositoryLicense must be MIT.');
    if (value.source.inspectedTreeSha !== EXPECTED_REPOSITORY_SHA) errors.push('provenance.source.inspectedTreeSha is unexpected.');
    if (value.source.upstreamDataUrl !== EXPECTED_UPSTREAM_URL) errors.push('provenance.source.upstreamDataUrl is unexpected.');
    if (typeof value.source.runtimePolicy !== 'string' || !value.source.runtimePolicy.includes('never fetches')) errors.push('provenance.source.runtimePolicy must document offline runtime behavior.');
  }

  if (hasExactKeys(value.snapshot, ['retrievedAt', 'htmlSha256', 'dataSha256', 'normalizedCatalogSha256', 'observedHtmlTableRows', 'observedDmcRecordCount', 'sourceRgbMismatchCount', 'sourceRgbMismatches'], 'provenance.snapshot', errors)) {
    if (!isUtcTimestamp(value.snapshot.retrievedAt)) errors.push('provenance.snapshot.retrievedAt must be a UTC ISO-8601 timestamp.');
    if (!isSha256(value.snapshot.htmlSha256)) errors.push('provenance.snapshot.htmlSha256 must be a lowercase SHA-256 digest.');
    if (!isSha256(value.snapshot.dataSha256)) errors.push('provenance.snapshot.dataSha256 must be a lowercase SHA-256 digest.');
    if (value.snapshot.htmlSha256 !== value.snapshot.dataSha256) errors.push('provenance snapshot HTML/data hashes must agree.');
    if (!isSha256(value.snapshot.normalizedCatalogSha256)) errors.push('provenance.snapshot.normalizedCatalogSha256 must be a lowercase SHA-256 digest.');
    if (value.snapshot.observedHtmlTableRows !== EXPECTED_HTML_ROW_COUNT) errors.push(`provenance.snapshot.observedHtmlTableRows must be ${String(EXPECTED_HTML_ROW_COUNT)}.`);
    if (value.snapshot.observedDmcRecordCount !== EXPECTED_RECORD_COUNT) errors.push(`provenance.snapshot.observedDmcRecordCount must be ${String(EXPECTED_RECORD_COUNT)}.`);
    if (!Array.isArray(value.snapshot.sourceRgbMismatches)) errors.push('provenance.snapshot.sourceRgbMismatches must be an array.');
    else {
      if (value.snapshot.sourceRgbMismatchCount !== value.snapshot.sourceRgbMismatches.length) errors.push('provenance source RGB mismatch count is not bound to its detail list.');
      for (const [index, mismatch] of value.snapshot.sourceRgbMismatches.entries()) {
        const path = `provenance.snapshot.sourceRgbMismatches[${String(index)}]`;
        if (!hasExactKeys(mismatch, ['code', 'sourceRgb', 'hexRgb'], path, errors)) continue;
        if (typeof mismatch.code !== 'string' || !/^[0-9A-Za-z]+$/.test(mismatch.code)) errors.push(`${path}.code is malformed.`);
        if (!isRgb(mismatch.sourceRgb) || !isRgb(mismatch.hexRgb)) errors.push(`${path} RGB details must contain three bytes.`);
      }
    }
  }

  if (hasExactKeys(value.extraction, ['parser', 'rules', 'validation'], 'provenance.extraction', errors)) {
    if (value.extraction.parser !== 'scripts/build-dmc-catalog.mjs') errors.push('provenance.extraction.parser is unexpected.');
    if (!Array.isArray(value.extraction.rules) || value.extraction.rules.length === 0 || value.extraction.rules.some((rule) => typeof rule !== 'string' || !rule.trim())) errors.push('provenance.extraction.rules must contain non-empty strings.');
    if (typeof value.extraction.validation !== 'string' || !value.extraction.validation.trim()) errors.push('provenance.extraction.validation must be non-empty.');
  }

  if (hasExactKeys(value.status, ['official', 'approximation', 'description', 'dmcAffiliation', 'unresolvedUpstreamRightsWarning'], 'provenance.status', errors)) {
    if (value.status.official !== false) errors.push('provenance.status.official must be false.');
    if (value.status.approximation !== true) errors.push('provenance.status.approximation must be true.');
    if (typeof value.status.description !== 'string' || !value.status.description.toLowerCase().includes('approximation')) errors.push('provenance.status.description must identify an approximation.');
    if (value.status.dmcAffiliation !== false) errors.push('provenance.status.dmcAffiliation must be false.');
    if (typeof value.status.unresolvedUpstreamRightsWarning !== 'string' || !value.status.unresolvedUpstreamRightsWarning.trim()) errors.push('provenance.status.unresolvedUpstreamRightsWarning is required.');
  }
  return errors.length === 0;
}

function freezeColor(record: CatalogAsset['records'][number]): DmcCatalogColor {
  return Object.freeze({
    sourceId: record.sourceId,
    code: record.code,
    name: record.name,
    hex: record.hex as `#${string}`,
    rgb: Object.freeze([record.rgb[0], record.rgb[1], record.rgb[2]]) as readonly [number, number, number]
  });
}

export const DMC_CATALOG: readonly DmcCatalogColor[] = Object.freeze(rawCatalog.records.map(freezeColor));
export const DMC_CATALOG_RECORD_COUNT = DMC_CATALOG.length;

function validateCatalogAsset(value: unknown, errors: string[]): value is CatalogAsset {
  if (!hasExactKeys(value, ['schemaVersion', 'catalogId', 'records'], 'catalog', errors)) return false;
  if (value.schemaVersion !== EXPECTED_CATALOG_SCHEMA_VERSION) errors.push('catalog.schemaVersion is unsupported.');
  if (value.catalogId !== EXPECTED_CATALOG_ID) errors.push('catalog.catalogId is unexpected.');
  validateRecordList(value.records, errors, 'catalog.records');
  return errors.length === 0;
}

export function validateDmcCatalogBundle(catalogInput: unknown = rawCatalog, provenanceInput: unknown = rawProvenance): DmcCatalogValidation {
  const errors: string[] = [];
  validateCatalogAsset(catalogInput, errors);
  validateProvenance(provenanceInput, errors);
  if (isRecord(catalogInput) && isRecord(provenanceInput)) {
    if (catalogInput.catalogId !== undefined && provenanceInput.catalogId !== undefined && catalogInput.catalogId !== provenanceInput.catalogId) errors.push('catalog and provenance catalogId values must agree.');
    const catalogRecords = catalogInput.records;
    const provenanceSnapshot = provenanceInput.snapshot;
    if (Array.isArray(catalogRecords) && isRecord(provenanceSnapshot)) {
      if (typeof provenanceSnapshot.observedDmcRecordCount === 'number' && provenanceSnapshot.observedDmcRecordCount !== catalogRecords.length) errors.push('provenance observed record count does not match the catalog.');
      const serializedCatalog = stableJson(catalogInput);
      if (serializedCatalog && typeof provenanceSnapshot.normalizedCatalogSha256 === 'string' && provenanceSnapshot.normalizedCatalogSha256 !== sha256(serializedCatalog)) errors.push('provenance normalizedCatalogSha256 does not match the catalog asset.');
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

const DMC_CATALOG_VALIDATION = validateDmcCatalogBundle();
if (!DMC_CATALOG_VALIDATION.valid) throw new Error(`Invalid committed DMC catalog bundle: ${DMC_CATALOG_VALIDATION.errors.join(' ')}`);

const dmcByCode = new Map<string, CatalogRecord>(DMC_CATALOG.map((record) => [record.code.toUpperCase(), record]));

export const DMC_CATALOG_DEFINITION: CatalogDefinition = createCatalogDefinition(
  { catalogId: rawCatalog.catalogId, brandLabel: 'DMC', colorCount: DMC_CATALOG_RECORD_COUNT },
  DMC_CATALOG,
  'DMC-compatible',
  MaterialKind.Floss,
);

const MILL_HILL_CATALOG_DEFINITION = createMillHillCatalogDefinition(DMC_CATALOG);
/** A bead's size in millimetres: `diameterMm` across, `lengthMm` along the hole. */
export interface BeadSizeMm {
  readonly diameterMm: number;
  readonly lengthMm: number;
}

/** One size of bead a catalog sells. */
export interface BeadSize extends BeadSizeMm {
  readonly id: string;
  readonly label: string;
  readonly gauge: string;
}

/** A catalog bead's series and size. */
export interface BeadKind {
  readonly series: string;
  readonly size: BeadSize;
}

const millHillKindBySourceId = new Map<string, BeadKind>(MILL_HILL_CATALOG_DEFINITION.records.map((record) => [
  record.sourceId,
  Object.freeze({ series: record.series, size: record.size }),
]));

const MILL_HILL_SIZES: readonly BeadSize[] = Object.freeze(
  [...new Set(MILL_HILL_CATALOG_DEFINITION.records.map((record) => record.size))].sort((a, b) => a.diameterMm - b.diameterMm),
);

const NO_BEAD_SIZES: readonly BeadSize[] = Object.freeze([]);

/** The sizes a bead catalog sells, smallest first; empty for any catalog without bead sizes. */
export function beadSizes(catalog: Pick<CatalogDefinition, 'association'>): readonly BeadSize[] {
  return catalog.association.catalogId === MILL_HILL_CATALOG_DEFINITION.association.catalogId ? MILL_HILL_SIZES : NO_BEAD_SIZES;
}

/** A catalog bead's series and size, or undefined when no installed bead catalog lists it. */
export function beadKindOf(reference: { readonly catalogId: string; readonly sourceId: string }): BeadKind | undefined {
  if (reference.catalogId !== MILL_HILL_CATALOG_DEFINITION.association.catalogId) return undefined;
  return millHillKindBySourceId.get(reference.sourceId);
}

/** An 11/0 seed bead's size: the size of a bead the installed catalog no longer lists. */
export const SEED_BEAD_SIZE_MM: BeadSizeMm = Object.freeze({ diameterMm: 2.5, lengthMm: 1.75 });

/** A bead entry's size in millimetres, from its Mill Hill record, or a seed bead's when the catalog lacks it. */
export function beadSizeMm(entry: Pick<PaletteEntry, 'catalog'>): BeadSizeMm {
  return (entry.catalog && beadKindOf(entry.catalog)?.size) || SEED_BEAD_SIZE_MM;
}

export const DEFAULT_CATALOG_DEFINITION = DMC_CATALOG_DEFINITION;

export interface InstalledCatalogRegistry {
  readonly definitions: readonly CatalogDefinition[];
  resolve(association: CatalogAssociation): CatalogDefinition | undefined;
}

const installedDefinitions: readonly CatalogDefinition[] = Object.freeze([DMC_CATALOG_DEFINITION, MILL_HILL_CATALOG_DEFINITION]);

/** Production's installed catalogs. */
export const INSTALLED_CATALOG_REGISTRY: InstalledCatalogRegistry = Object.freeze({
  definitions: installedDefinitions,
  resolve: (association: CatalogAssociation) => installedDefinitions.find((definition) => (
    definition.association.catalogId === association.catalogId
    && definition.association.brandLabel === association.brandLabel
    && definition.association.colorCount === association.colorCount
  ))
});

export function createCatalogReference(
  definition: Pick<CatalogDefinition, 'association'>,
  record: CatalogRecord,
): PaletteCatalogReference {
  return {
    catalogId: definition.association.catalogId,
    sourceId: record.sourceId,
    code: record.code,
    name: record.name,
    hex: record.hex,
    rgb: [record.rgb[0], record.rgb[1], record.rgb[2]],
  };
}

/** Codes the catalog once used, still accepted by lookups. */
const DMC_CODE_ALIASES: ReadonlyMap<string, string> = new Map([['WHITE', 'BLANC']]);

/** Look up a code such as "09", "B5200", or "Ecru". Numeric callers cannot express leading zeroes. */
export function getDmcColor(code: string | number): DmcCatalogColor | undefined {
  const value = String(code).trim().toUpperCase();
  const normalized = value.startsWith('DMC-') ? value.slice(4) : value;
  return normalized ? dmcByCode.get(DMC_CODE_ALIASES.get(normalized) ?? normalized) : undefined;
}

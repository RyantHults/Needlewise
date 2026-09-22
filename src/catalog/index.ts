import catalogAsset from '../../catalog/dmc-colors.json';
import provenanceAsset from '../../catalog/provenance.json';
import type { CatalogAssociation, PaletteCatalogReference } from '../domain/types';

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
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[], path: string, errors: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${path}.${key} is not allowed.`);
  return true;
}

function isRgb(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255);
}

function expectedRgb(hex: string): [number, number, number] | undefined {
  if (!/^#[0-9A-F]{6}$/.test(hex)) return undefined;
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

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

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
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

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const highLength = Math.floor(bitLength / 0x100000000);
  const lowLength = bitLength >>> 0;
  padded[padded.length - 8] = (highLength >>> 24) & 0xff;
  padded[padded.length - 7] = (highLength >>> 16) & 0xff;
  padded[padded.length - 6] = (highLength >>> 8) & 0xff;
  padded[padded.length - 5] = highLength & 0xff;
  padded[padded.length - 4] = (lowLength >>> 24) & 0xff;
  padded[padded.length - 3] = (lowLength >>> 16) & 0xff;
  padded[padded.length - 2] = (lowLength >>> 8) & 0xff;
  padded[padded.length - 1] = lowLength & 0xff;
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = ((padded[position] << 24) | (padded[position + 1] << 16) | (padded[position + 2] << 8) | padded[position + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const small0 = (rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)) >>> 0;
      const small1 = (rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)) >>> 0;
      words[index] = (words[index - 16] + small0 + words[index - 7] + small1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const big1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const first = (h + big1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const big0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const second = (big0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function stableJson(value: unknown): string | undefined {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? undefined : `${serialized}\n`;
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
export const DMC_CATALOG_PROVENANCE: DmcCatalogProvenance = Object.freeze(rawProvenance);
export const DMC_CATALOG_RECORD_COUNT = DMC_CATALOG.length;
export const DMC_CATALOG_IS_OFFLINE_ONLY = true;
export const DMC_CATALOG_METADATA = Object.freeze({
  catalogId: rawCatalog.catalogId,
  recordCount: DMC_CATALOG_RECORD_COUNT,
  official: rawProvenance.status.official,
  approximation: rawProvenance.status.approximation,
  dmcAffiliation: rawProvenance.status.dmcAffiliation,
  offlineOnly: DMC_CATALOG_IS_OFFLINE_ONLY,
  provenance: DMC_CATALOG_PROVENANCE
});

function validateCatalogAsset(value: unknown, errors: string[]): value is CatalogAsset {
  if (!hasExactKeys(value, ['schemaVersion', 'catalogId', 'records'], 'catalog', errors)) return false;
  if (value.schemaVersion !== EXPECTED_CATALOG_SCHEMA_VERSION) errors.push('catalog.schemaVersion is unsupported.');
  if (value.catalogId !== EXPECTED_CATALOG_ID) errors.push('catalog.catalogId is unexpected.');
  validateRecordList(value.records, errors, 'catalog.records');
  return errors.length === 0;
}

export function validateDmcCatalog(records: readonly DmcCatalogColor[] = DMC_CATALOG): DmcCatalogValidation {
  const errors: string[] = [];
  validateRecordList(records, errors, 'catalog.records');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
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

export const validateCatalogBundle = validateDmcCatalogBundle;

export const DMC_CATALOG_VALIDATION = validateDmcCatalogBundle();
if (!DMC_CATALOG_VALIDATION.valid) throw new Error(`Invalid committed DMC catalog bundle: ${DMC_CATALOG_VALIDATION.errors.join(' ')}`);

const dmcByCode = new Map<string, CatalogRecord>(DMC_CATALOG.map((record) => [record.code.toUpperCase(), record]));
const dmcByHex = new Map<string, CatalogRecord>(DMC_CATALOG.map((record) => [record.hex.toUpperCase(), record]));

function validateSearchLimit(limit: number | undefined, message = 'Catalog search limit must be a non-negative integer.'): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError(message);
}

function searchCatalogRecords(records: readonly CatalogRecord[], query: string, limit: number | undefined): readonly CatalogRecord[] {
  validateSearchLimit(limit);
  const needle = query.trim().toLowerCase();
  const matches = needle.length === 0
    ? [...records]
    : records.filter((record) => [record.code, record.name, record.hex, record.sourceId].some((field) => field.toLowerCase().includes(needle)));
  return Object.freeze(limit === undefined ? matches : matches.slice(0, limit));
}

function getCatalogRecordByHex(recordsByHex: ReadonlyMap<string, CatalogRecord>, value: string): CatalogRecord | undefined {
  const hex = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(hex) ? recordsByHex.get(hex) : undefined;
}

function nearestCatalogRecord(records: readonly CatalogRecord[], input: { readonly r: number; readonly g: number; readonly b: number }): CatalogRecord | undefined {
  let best: CatalogRecord | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const [r, g, b] = record.rgb;
    const distance = (r - input.r) ** 2 + (g - input.g) ** 2 + (b - input.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = record;
    }
  }
  return best;
}

const dmcAssociation: CatalogAssociation = Object.freeze({
  catalogId: rawCatalog.catalogId,
  brandLabel: 'DMC',
  colorCount: DMC_CATALOG_RECORD_COUNT
});

const dmcSnapshot: CatalogSnapshot = Object.freeze({
  association: dmcAssociation,
  records: DMC_CATALOG
});

export const DMC_CATALOG_DEFINITION: CatalogDefinition = Object.freeze({
  association: dmcAssociation,
  records: DMC_CATALOG,
  compatibilityLabel: 'DMC-compatible',
  snapshot: dmcSnapshot,
  search: (query: string, options: { readonly limit?: number } = {}) => searchCatalogRecords(DMC_CATALOG, query, options.limit),
  getByHex: (hex: string) => getCatalogRecordByHex(dmcByHex, hex),
  nearest: (rgb: { readonly r: number; readonly g: number; readonly b: number }) => nearestCatalogRecord(DMC_CATALOG, rgb)
});

export const DEFAULT_CATALOG_DEFINITION = DMC_CATALOG_DEFINITION;

const registeredDefinitions = new Map<string, CatalogDefinition>([[dmcAssociation.catalogId, DMC_CATALOG_DEFINITION]]);

export function resolveCatalogDefinition(association: CatalogAssociation): CatalogDefinition | undefined {
  const definition = registeredDefinitions.get(association.catalogId);
  if (definition === undefined || definition.association.brandLabel !== association.brandLabel || definition.association.colorCount !== association.colorCount) return undefined;
  return definition;
}

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

/** Look up a code such as "09", "B5200", or "Ecru". Numeric callers cannot express leading zeroes. */
export function getDmcColor(code: string | number): DmcCatalogColor | undefined {
  const value = String(code).trim().toUpperCase();
  const normalized = value.startsWith('DMC-') ? value.slice(4) : value;
  return normalized ? dmcByCode.get(normalized) : undefined;
}

export function getDmcColorByHex(value: string): DmcCatalogColor | undefined {
  return DMC_CATALOG_DEFINITION.getByHex(value);
}

export interface NearestDmcColorInput {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Return the catalog color whose RGB is closest (squared Euclidean distance) to the input. */
export function nearestDmcColor(input: NearestDmcColorInput): DmcCatalogColor | undefined {
  return DMC_CATALOG_DEFINITION.nearest(input);
}

export interface DmcSearchOptions {
  readonly limit?: number;
}

/** Search the committed code, name, HEX, and stable source ID fields without network access. */
export function searchDmcColors(query: string, options: DmcSearchOptions | number = {}): readonly DmcCatalogColor[] {
  const limit = typeof options === 'number' ? options : options.limit;
  validateSearchLimit(limit, 'DMC search limit must be a non-negative integer.');
  return DMC_CATALOG_DEFINITION.search(query, { limit });
}

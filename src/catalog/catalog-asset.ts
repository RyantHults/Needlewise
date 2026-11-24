import type { CatalogAssociation, MaterialKind } from '../domain/types';
import { parseHexColor, type Rgb } from '../domain/color';
import { isRecord } from '../domain/guards';
import type { CatalogDefinition, CatalogRecord } from './index';

/** Validation and lookup shared by every committed catalog asset. */

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

export function hasExactKeys(value: unknown, keys: readonly string[], path: string, errors: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${path}.${key} is not allowed.`);
  return true;
}

export function isRgb(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255);
}

export function expectedRgb(hex: string): Rgb | undefined {
  return /^#[0-9A-F]{6}$/.test(hex) ? parseHexColor(hex) : undefined;
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256(value: string): string {
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

export function stableJson(value: unknown): string | undefined {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? undefined : `${serialized}\n`;
}

function validateSearchLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('Catalog search limit must be a non-negative integer.');
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

/** Freeze a catalog's records behind the search, exact-hex, and nearest-RGB lookups every catalog offers. When records share a HEX value, the first one wins the exact lookup. */
export function createCatalogDefinition(
  association: CatalogAssociation,
  records: readonly CatalogRecord[],
  compatibilityLabel: string,
  materialKind: MaterialKind,
): CatalogDefinition {
  const byHex = new Map<string, CatalogRecord>();
  for (const record of records) if (!byHex.has(record.hex.toUpperCase())) byHex.set(record.hex.toUpperCase(), record);
  const frozenAssociation = Object.freeze({ ...association });
  return Object.freeze({
    association: frozenAssociation,
    records,
    compatibilityLabel,
    materialKind,
    snapshot: Object.freeze({ association: frozenAssociation, records }),
    search: (query: string, options: { readonly limit?: number } = {}) => searchCatalogRecords(records, query, options.limit),
    getByHex: (hex: string) => getCatalogRecordByHex(byHex, hex),
    nearest: (rgb: { readonly r: number; readonly g: number; readonly b: number }) => nearestCatalogRecord(records, rgb)
  });
}

import { DEFAULT_CATALOG_DEFINITION, createCatalogReference, getDmcColor, type CatalogDefinition, type CatalogRecord } from '../catalog';
import { CellKind, MAX_PERSISTABLE_CELL_COUNT, PALETTE_ID_MAX, type PaletteEntryInput, type PatternDocument } from '../domain/types';
import { parseHexColor } from '../domain/color';
import { createDocument, defaultPaletteSymbol } from '../domain/model';
import { assertValidDocument } from '../domain/validation';
import { SYMBOL_IDS, SYMBOL_POOL } from '../symbols';
import { normalizeSvgPath, outlineDistance } from './pdf/outline';
import {
  ImportError,
  type ImportedChart,
  type SymbolMapping,
  type SymbolMappingProposal
} from './types';

/** Largest `outlineDistance` still treated as the same shape as a pool symbol. */
const OUTLINE_MATCH_TOLERANCE = 0.02;

export interface PoolCandidate {
  readonly id: string;
  readonly d: string;
}

/** Returns the slug of the candidate that matches the outline, if any. Injectable for tests. */
export type OutlineMatcher = (outlineD: string, candidates: readonly PoolCandidate[]) => string | undefined;

export interface SlugOptions {
  readonly matchOutline?: OutlineMatcher;
}

export interface BuildOptions extends SlugOptions {
  readonly catalog?: CatalogDefinition;
  readonly aidaCount?: number;
}

const normalizedPoolPaths = new Map<string, string>();

function normalizedPoolPath(candidate: PoolCandidate): string {
  const cached = normalizedPoolPaths.get(candidate.d);
  if (cached !== undefined) return cached;
  const normalized: string = normalizeSvgPath(candidate.d);
  normalizedPoolPaths.set(candidate.d, normalized);
  return normalized;
}

/** Nearest candidate within tolerance wins, not the first one under it. */
export function nearestPoolOutline(
  outlineD: string,
  candidates: readonly PoolCandidate[],
  distance: (a: string, b: string) => number = outlineDistance
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = distance(outlineD, normalizedPoolPath(candidate));
    if (d <= OUTLINE_MATCH_TOLERANCE && d < bestDistance) {
      best = candidate.id;
      bestDistance = d;
    }
  }
  return best;
}

function isDmcBrand(brand: string | undefined): boolean {
  return brand === undefined || brand.trim().toUpperCase() === 'DMC';
}

/** One proposal per chart symbol, in symbol order. */
export function proposeMappings(chart: ImportedChart, catalog: CatalogDefinition = DEFAULT_CATALOG_DEFINITION): SymbolMappingProposal[] {
  return chart.symbols.map((symbol): SymbolMappingProposal => {
    const entry = chart.key.find((candidate) => candidate.symbolKey === symbol.key);
    let reason: string | undefined;
    if (entry === undefined) {
      reason = 'The symbol is missing from the key.';
    } else if (entry.blendCodes !== undefined && entry.blendCodes.length > 1) {
      reason = `Blend ${entry.blendCodes.join('+')} is not supported.`;
    } else if (!isDmcBrand(entry.brand)) {
      reason = `${entry.brand ?? 'This'} threads are not in the catalog.`;
    } else if (entry.code === undefined) {
      reason = 'The key has no thread code for this symbol.';
    } else {
      const record = getDmcColor(entry.code);
      if (record !== undefined) return { symbolKey: symbol.key, catalogCode: record.code, status: 'matched' };
      reason = `Thread code ${entry.code} is not in the catalog.`;
    }
    const color = symbol.fillColor ?? entry?.color;
    const rgb = color === undefined ? undefined : parseHexColor(color);
    const nearest = rgb === undefined ? undefined : catalog.nearest({ r: rgb[0], g: rgb[1], b: rgb[2] });
    if (color === undefined || nearest === undefined) return { symbolKey: symbol.key, status: 'unmapped', reason };
    return { symbolKey: symbol.key, catalogCode: nearest.code, color, status: 'guessed', reason: `${reason} Matched by color.` };
  });
}

/** Maps each symbol key to a unique pool slug. */
export function assignSymbolSlugs(
  chart: ImportedChart,
  mappings: readonly SymbolMapping[],
  options: SlugOptions = {}
): ReadonlyMap<string, string> {
  const matchOutline = options.matchOutline ?? nearestPoolOutline;
  const slugs = new Map<string, string>();
  const used = new Set<string>();
  const claim = (key: string, slug: string): void => {
    slugs.set(key, slug);
    used.add(slug);
  };

  // Explicit choices come first so an automatic pick can never take their slug.
  for (const mapping of mappings) {
    const slug = mapping.symbolSlug;
    if (slug !== undefined && SYMBOL_IDS.includes(slug) && !used.has(slug) && !slugs.has(mapping.symbolKey)) {
      claim(mapping.symbolKey, slug);
    }
  }

  chart.symbols.forEach((symbol, index) => {
    if (slugs.has(symbol.key)) return;
    const free = SYMBOL_POOL.filter((entry) => !used.has(entry.id));
    const byOutline = matchOutline(symbol.outlineD, free);
    if (byOutline !== undefined) return claim(symbol.key, byOutline);
    const codepoint = symbol.unicode?.codePointAt(0);
    const byCodepoint = codepoint === undefined ? undefined : free.find((entry) => entry.codepoint === codepoint);
    if (byCodepoint !== undefined) return claim(symbol.key, byCodepoint.id);
    const id = index + 1;
    for (let offset = 0; offset < SYMBOL_IDS.length; offset += 1) {
      const candidate = SYMBOL_IDS[(id - 1 + offset) % SYMBOL_IDS.length];
      if (!used.has(candidate)) return claim(symbol.key, candidate);
    }
    // Pool exhausted: the cycled default is the duplicate the validator allows.
    claim(symbol.key, defaultPaletteSymbol(id));
  });
  return slugs;
}

function recordOf(mapping: SymbolMapping | undefined): CatalogRecord | undefined {
  return mapping?.catalogCode === undefined ? undefined : getDmcColor(mapping.catalogCode);
}

/** Most colors a chart can have and still become a document. */
export function maxImportColors(catalog: CatalogDefinition = DEFAULT_CATALOG_DEFINITION): number {
  return Math.min(catalog.association.colorCount, PALETTE_ID_MAX);
}

export function buildImportedDocument(chart: ImportedChart, mappings: readonly SymbolMapping[], options: BuildOptions = {}): PatternDocument {
  const catalog = options.catalog ?? DEFAULT_CATALOG_DEFINITION;
  const cellCount = chart.width * chart.height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) {
    throw new ImportError('too-large', 'This chart has too many stitches to import.');
  }
  const limit = maxImportColors(catalog);
  if (chart.symbols.length > limit) {
    throw new ImportError('too-many-colors', `This chart uses ${String(chart.symbols.length)} colors, but the catalog allows at most ${String(limit)}.`);
  }

  const byKey = new Map(mappings.map((mapping) => [mapping.symbolKey, mapping]));
  const unmapped = chart.symbols.filter((symbol) => {
    const mapping = byKey.get(symbol.key);
    return recordOf(mapping) === undefined && mapping?.color === undefined;
  });
  if (unmapped.length > 0) {
    throw new ImportError('unmapped-symbols', `${String(unmapped.length)} symbol${unmapped.length === 1 ? ' has' : 's have'} no thread or color.`);
  }

  const slugs = assignSymbolSlugs(chart, mappings, options);
  const palette: PaletteEntryInput[] = chart.symbols.map((symbol, index) => {
    const mapping = byKey.get(symbol.key);
    const record = recordOf(mapping);
    const symbolSlug = slugs.get(symbol.key);
    if (record !== undefined) {
      return { id: index + 1, name: record.name, color: record.hex, active: true, symbol: symbolSlug, catalog: createCatalogReference(catalog, record) };
    }
    const color = (mapping?.color ?? '#000000').toUpperCase();
    const name = chart.key.find((entry) => entry.symbolKey === symbol.key)?.name?.trim();
    return { id: index + 1, name: name || color, color, active: true, symbol: symbolSlug };
  });

  const document = createDocument({
    width: chart.width,
    height: chart.height,
    catalog: catalog.association,
    palette,
    ...(options.aidaCount === undefined ? {} : { settings: { aidaCount: options.aidaCount } })
  });
  for (let index = 0; index < cellCount; index += 1) {
    const symbol = chart.cells[index];
    if (symbol === 0 || symbol > chart.symbols.length) continue;
    document.kind[index] = CellKind.Full;
    document.colors[index * 4] = symbol;
  }
  assertValidDocument(document);
  return document;
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATH = resolve(REPO_ROOT, 'catalog/source/mill-hill-dmc-conversion.csv');
export const DMC_CATALOG_PATH = resolve(REPO_ROOT, 'catalog/dmc-colors.json');
export const OUTPUT_PATH = resolve(REPO_ROOT, 'catalog/mill-hill-beads.json');
export const PROVENANCE_PATH = resolve(REPO_ROOT, 'catalog/mill-hill-provenance.json');

const CATALOG_ID = 'mill-hill-dmc-mapped-approximation';
const SOURCE_URL = 'http://www.millhillbeads.com/images/bead_to_dmc_conversion.pdf';
const SOURCE_PDF_SHA256 = '2d81ef8097848ea344aba5040338db08b0954cd2e5a461265ac0b7932ff15852';
const RETRIEVED_AT = '2026-11-04';
const HEADER = 'code,name,series,dmc';
const STALE_MESSAGE = 'run `pnpm catalog:mill-hill` and commit the result.';

/**
 * The round bead series the catalog keeps, in chart order. Bugles are not
 * point-shaped, so their sections stay in the transcription but not the catalog.
 */
export const ROUND_SERIES = Object.freeze([
  'Glass Seed',
  'Antique Glass',
  'Crayon Seed',
  'Frosted Glass',
  'Petite Glass',
  'Size 3 Pebble',
  'Size 6',
  'Size 8',
  'Magnifica'
]);
/**
 * Each kept series' bead diameter in millimetres, so beads draw at true size
 * against the fabric count. Mill Hill's listings give 11/0 seed 2.5, 15/0
 * petite 2.0, size 8 3.0, size 6 4.0 and size 3 pebble 5.5; Magnifica has no
 * Mill Hill figure, so it takes the Miyuki Delica 11/0 analogue.
 */
export const DIAMETER_MM_BY_SERIES = Object.freeze({
  'Glass Seed': 2.5,
  'Antique Glass': 2.5,
  'Crayon Seed': 2.5,
  'Frosted Glass': 2.5,
  'Petite Glass': 2.0,
  'Size 3 Pebble': 5.5,
  'Size 6': 4.0,
  'Size 8': 3.0,
  Magnifica: 1.6
});
/**
 * Each kept series' bead length along the hole in millimetres, because a
 * stitched bead lies on its side. Mill Hill publishes no lengths, so these are
 * typical proportions: 0.7 × diameter for round rocailles and 0.8 × for the
 * Magnifica cylinder (Delica 11/0 is 1.6 × 1.3 mm).
 */
export const LENGTH_MM_BY_SERIES = Object.freeze({
  'Glass Seed': 1.75,
  'Antique Glass': 1.75,
  'Crayon Seed': 1.75,
  'Frosted Glass': 1.75,
  'Petite Glass': 1.4,
  'Size 3 Pebble': 3.85,
  'Size 6': 2.8,
  'Size 8': 2.1,
  Magnifica: 1.3
});
const BUGLE_SERIES = Object.freeze(['Small Bugle', 'Medium Bugle', 'Large Bugle']);

/** The chart's mark for a bead it no longer maps (replaced or potpourri rows). */
const UNMAPPED_DMC = 'X';
/** The chart's DMC spellings that differ from the DMC catalog's codes. */
const DMC_SPELLINGS = new Map([['Wht.', 'Blanc']]);

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');
const serialize = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

/** Parse the transcription. It is hand-authored, so every malformed line fails with its line number. */
export function parseConversionCsv(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== HEADER) throw new Error(`The conversion CSV header must be "${HEADER}".`);
  const knownSeries = new Set([...ROUND_SERIES, ...BUGLE_SERIES]);
  return lines.slice(1).map((line, index) => {
    const lineNumber = index + 2;
    const fields = line.split(',');
    if (fields.length !== 4 || line.includes('"')) throw new Error(`Line ${lineNumber} must have four unquoted fields.`);
    const [code, name, series, dmc] = fields;
    if (!/^\d{5}$/.test(code)) throw new Error(`Line ${lineNumber} has a bead code that is not five digits: ${JSON.stringify(code)}.`);
    if (!name || name !== name.trim()) throw new Error(`Line ${lineNumber} has an empty or padded name.`);
    if (!knownSeries.has(series)) throw new Error(`Line ${lineNumber} names an unknown series: ${JSON.stringify(series)}.`);
    if (!dmc || dmc !== dmc.trim()) throw new Error(`Line ${lineNumber} has an empty or padded DMC code.`);
    return { code, name, series, dmc };
  });
}

/** Keep round-series rows the chart maps to a DMC thread. */
export function selectRoundBeads(rows) {
  const round = new Set(ROUND_SERIES);
  return rows.filter((row) => round.has(row.series) && row.dmc !== UNMAPPED_DMC);
}

/** Resolve each bead to its DMC record and its series' size. Unresolved codes, unsized series and duplicate bead codes fail the build. */
export function buildRecords(rows, dmcCatalog) {
  const dmcByCode = new Map(dmcCatalog.records.map((record) => [record.code.toUpperCase(), record]));
  const seen = new Set();
  return rows.map((row) => {
    if (seen.has(row.code)) throw new Error(`Duplicate Mill Hill bead code: ${row.code}.`);
    seen.add(row.code);
    const dmc = dmcByCode.get((DMC_SPELLINGS.get(row.dmc) ?? row.dmc).toUpperCase());
    if (!dmc) throw new Error(`Mill Hill ${row.code} maps to DMC ${JSON.stringify(row.dmc)}, which the DMC catalog does not have.`);
    const diameterMm = Object.hasOwn(DIAMETER_MM_BY_SERIES, row.series) ? DIAMETER_MM_BY_SERIES[row.series] : undefined;
    const lengthMm = Object.hasOwn(LENGTH_MM_BY_SERIES, row.series) ? LENGTH_MM_BY_SERIES[row.series] : undefined;
    if (diameterMm === undefined || lengthMm === undefined) throw new Error(`Mill Hill ${row.code} is in series ${JSON.stringify(row.series)}, which has no bead size.`);
    return {
      sourceId: `mill-hill-${row.code}`,
      code: row.code,
      name: row.name,
      series: row.series,
      dmcCode: dmc.code,
      diameterMm,
      lengthMm,
      hex: dmc.hex,
      rgb: [dmc.rgb[0], dmc.rgb[1], dmc.rgb[2]]
    };
  });
}

function seriesCounts(records) {
  return Object.fromEntries(ROUND_SERIES.map((series) => [series, records.filter((record) => record.series === series).length]));
}

function buildProvenance(catalogText, rows, records) {
  return {
    schemaVersion: 1,
    catalogId: CATALOG_ID,
    source: {
      url: SOURCE_URL,
      title: 'DMC to Glass Bead Conversion (Product #CCB)',
      publisher: 'Mill Hill, a division of Wichelt Imports, Inc.',
      documentDate: 'updated 2010',
      pdfSha256: SOURCE_PDF_SHA256,
      retrievedAt: RETRIEVED_AT,
      transcription: 'catalog/source/mill-hill-dmc-conversion.csv',
      transcriptionMethod: 'Transcribed by hand from the rendered pages of the PDF, checked against its text layer, every row in chart order. Trailing care markers (• and *) are dropped from names; codes, names, and DMC numbers are otherwise kept as printed.',
      runtimePolicy: 'The application reads only the committed normalized asset; it never fetches the source PDF.'
    },
    snapshot: {
      transcribedRowCount: rows.length,
      recordCount: records.length,
      seriesCounts: seriesCounts(records),
      normalizedCatalogSha256: sha256(catalogText)
    },
    beadSizes: {
      diameterMmBySeries: DIAMETER_MM_BY_SERIES,
      lengthMmBySeries: LENGTH_MM_BY_SERIES,
      sources: [
        'Seed (11/0), petite (15/0), size 8, size 6 and size 3 pebble diameters are from 123stitch.com\'s Mill Hill product listings.',
        'Magnifica has no published Mill Hill diameter; it uses the Miyuki Delica 11/0 cylinder (1.6 mm) as the analogue.',
        'The petite (15/0) figure is disputed: other sellers list 15/0 seed beads at 1.5 mm.',
        'Lengths along the hole have no Mill Hill figure; they are typical proportions: 0.7 × diameter for round rocailles and 0.8 × for the Magnifica cylinder, after the Delica 11/0 (1.6 × 1.3 mm).'
      ]
    },
    extraction: {
      builder: 'scripts/build-mill-hill-catalog.mjs',
      rules: [
        `Keep only the round series: ${ROUND_SERIES.join(', ')}. Bugle sections are excluded.`,
        'Exclude rows whose DMC column is X (replaced and potpourri beads).',
        'Map the chart spelling Wht. to DMC Blanc; every other DMC code must match a DMC catalog code.',
        'Take each bead colour from its mapped DMC record in catalog/dmc-colors.json.',
        'Reject unknown series, malformed codes, duplicate bead codes, and DMC codes the DMC catalog lacks.'
      ]
    },
    status: {
      official: false,
      approximation: true,
      description: 'Each bead colour is the screen approximation of the DMC thread Mill Hill maps it to; it is not a measurement of the bead. Mill Hill notes that the DMC mapping can vary with dye lots.',
      millHillAffiliation: false,
      unresolvedUpstreamRightsWarning: 'The Mill Hill conversion chart and its product names may carry rights or attribution obligations not resolved by this transcription. Review Mill Hill\'s terms before redistribution or commercial use.'
    }
  };
}

function writeOrCheck(path, body, label, check) {
  if (!check) {
    writeFileSync(path, body);
    return;
  }
  let current;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${label} is missing; ${STALE_MESSAGE}`);
  }
  if (current !== body) throw new Error(`${label} is stale; ${STALE_MESSAGE}`);
}

/**
 * Build, or with `--check` verify, the catalog and its provenance.
 *
 * `paths` redirects every file the run reads or writes, and `log` takes the
 * line it reports, so a test can run check mode against a temp dir.
 */
export function main(argv, paths = {}) {
  const check = argv.includes('--check');
  const log = paths.log ?? ((line) => process.stdout.write(line));
  const rows = parseConversionCsv(readFileSync(paths.sourcePath ?? SOURCE_PATH, 'utf8'));
  const dmcCatalog = JSON.parse(readFileSync(paths.dmcCatalogPath ?? DMC_CATALOG_PATH, 'utf8'));
  const records = buildRecords(selectRoundBeads(rows), dmcCatalog);
  const catalogText = serialize({ schemaVersion: 1, catalogId: CATALOG_ID, records });
  const provenanceText = serialize(buildProvenance(catalogText, rows, records));
  writeOrCheck(paths.outputPath ?? OUTPUT_PATH, catalogText, 'mill-hill-beads.json', check);
  writeOrCheck(paths.provenancePath ?? PROVENANCE_PATH, provenanceText, 'mill-hill-provenance.json', check);
  log(`${check ? 'Mill Hill catalog is up to date' : 'Wrote Mill Hill catalog'}: ${records.length} beads from ${rows.length} transcribed rows.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DMC_CATALOG_PATH,
  OUTPUT_PATH,
  PROVENANCE_PATH,
  ROUND_SERIES,
  SOURCE_PATH,
  buildRecords,
  main,
  parseConversionCsv,
  selectRoundBeads
} from './build-mill-hill-catalog.mjs';

const tempDirs = [];
const SILENT = { log: () => {} };
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A temp copy of every file one build reads and writes. */
function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'mill-hill-build-'));
  tempDirs.push(dir);
  const paths = {
    sourcePath: join(dir, 'source.csv'),
    dmcCatalogPath: join(dir, 'dmc.json'),
    outputPath: join(dir, 'beads.json'),
    provenancePath: join(dir, 'provenance.json'),
    ...SILENT
  };
  copyFileSync(SOURCE_PATH, paths.sourcePath);
  copyFileSync(DMC_CATALOG_PATH, paths.dmcCatalogPath);
  copyFileSync(OUTPUT_PATH, paths.outputPath);
  copyFileSync(PROVENANCE_PATH, paths.provenancePath);
  return paths;
}

const dmcCatalog = JSON.parse(readFileSync(DMC_CATALOG_PATH, 'utf8'));
const csv = (lines) => ['code,name,series,dmc', ...lines, ''].join('\n');

describe('Mill Hill catalog build', () => {
  it('keeps the committed artifacts reproducible from the transcription', () => {
    expect(() => main(['--check'], SILENT)).not.toThrow();
  });

  it('keeps round beads and drops bugles and rows the chart no longer maps', () => {
    const rows = parseConversionCsv(csv([
      '00020,Royal Blue,Glass Seed,796',
      '03001,replaced w/2014,Antique Glass,X',
      '70020,Royal Blue,Small Bugle,796',
      '80777,Potpourri,Medium Bugle,X',
      '10009,White,Magnifica,Wht.'
    ]));
    expect(selectRoundBeads(rows).map((row) => row.code)).toEqual(['00020', '10009']);
  });

  it('builds only round series from the committed transcription', () => {
    const records = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')).records;
    expect(new Set(records.map((record) => record.series))).toEqual(new Set(ROUND_SERIES));
    expect(records.some((record) => record.dmcCode === 'X')).toBe(false);
  });

  it('maps the chart spellings of white and ecru to DMC records and takes their colours', () => {
    const rows = parseConversionCsv(csv(['00479,White,Glass Seed,Wht.', '00123,Cream,Glass Seed,Ecru']));
    const blanc = dmcCatalog.records.find((record) => record.code === 'Blanc');
    const ecru = dmcCatalog.records.find((record) => record.code === 'Ecru');
    expect(buildRecords(rows, dmcCatalog)).toEqual([
      { sourceId: 'mill-hill-00479', code: '00479', name: 'White', series: 'Glass Seed', dmcCode: 'Blanc', diameterMm: 2.5, lengthMm: 1.75, hex: blanc.hex, rgb: blanc.rgb },
      { sourceId: 'mill-hill-00123', code: '00123', name: 'Cream', series: 'Glass Seed', dmcCode: 'Ecru', diameterMm: 2.5, lengthMm: 1.75, hex: ecru.hex, rgb: ecru.rgb }
    ]);
  });

  it('fails on a kept series that has no bead size', () => {
    const rows = parseConversionCsv(csv(['00020,Royal Blue,Glass Seed,796']));
    expect(() => buildRecords(rows.map((row) => ({ ...row, series: 'Size 11 Cylinder' })), dmcCatalog)).toThrow();
  });

  it('fails on a DMC code the DMC catalog lacks or a repeated bead code', () => {
    expect(() => buildRecords(parseConversionCsv(csv(['00020,Royal Blue,Glass Seed,99999'])), dmcCatalog)).toThrow();
    expect(() => buildRecords(parseConversionCsv(csv(['00020,Royal Blue,Glass Seed,796', '00020,Royal Blue,Glass Seed,796'])), dmcCatalog)).toThrow();
  });

  it('fails on malformed transcription lines', () => {
    expect(() => parseConversionCsv(csv(['20,Royal Blue,Glass Seed,796']))).toThrow();
    expect(() => parseConversionCsv(csv(['00020,Royal Blue,Twisted Bugle,796']))).toThrow();
    expect(() => parseConversionCsv('code,dmc\n')).toThrow();
  });

  it('reports stale artifacts in check mode and rewrites them in build mode', () => {
    const paths = tempPaths();
    expect(() => main(['--check'], paths)).not.toThrow();
    writeFileSync(paths.sourcePath, `${readFileSync(paths.sourcePath, 'utf8')}10121,New Bead,Magnifica,310\n`);
    expect(() => main(['--check'], paths)).toThrow();
    main([], paths);
    expect(() => main(['--check'], paths)).not.toThrow();
    expect(JSON.parse(readFileSync(paths.outputPath, 'utf8')).records.at(-1)).toMatchObject({ code: '10121', dmcCode: '310' });
  });
});

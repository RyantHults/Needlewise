#!/usr/bin/env node

/* global process */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryUrl = 'https://github.com/syke99/go-c2dmc';
const repositoryTreeUrl = 'https://github.com/syke99/go-c2dmc/tree/1474067bf9c75a4acc15990eb086846f23e025b5';
const upstreamDataUrl = 'https://floss.maxxmint.com/dmc_to_rgb.php';
const inspectedRepositorySha = '1474067bf9c75a4acc15990eb086846f23e025b5';
const expectedRecordCount = 489;
const minimumRecordCount = 480;
const maximumRecordCount = 520;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  input: resolve(root, 'catalog/source/dmc_to_rgb.php'),
  output: resolve(root, 'catalog/dmc-colors.json'),
  provenance: resolve(root, 'catalog/provenance.json')
};

function usage() {
  process.stdout.write(`Usage: node scripts/build-dmc-catalog.mjs [options]\n\nOptions:\n  --input PATH          Local upstream HTML snapshot\n  --output PATH         Normalized catalog JSON\n  --provenance PATH     Provenance JSON\n  --retrieved-at ISO    Retrieval timestamp (required for a new provenance file)\n  --check               Validate and compare committed outputs without writing\n  --help                Show this help\n`);
}

function parseArgs(argv) {
  const args = { ...defaults, check: false, retrievedAt: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      usage();
      process.exit(0);
    }
    if (argument === '--check') {
      args.check = true;
      continue;
    }
    const [name, inlineValue] = argument.split('=', 2);
    const names = { '--input': 'input', '--output': 'output', '--provenance': 'provenance', '--retrieved-at': 'retrievedAt' };
    const key = names[name];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`Missing value for ${name}.`);
    args[key] = key === 'retrievedAt' ? value : resolve(root, value);
  }
  return args;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textContent(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

function parseIntegerCell(cell, label) {
  const value = textContent(cell);
  if (!/^\d+$/.test(value)) throw new Error(`${label} is not an integer: ${JSON.stringify(value)}`);
  const integer = Number(value);
  if (!Number.isInteger(integer) || integer < 0 || integer > 255) throw new Error(`${label} is outside the RGB range: ${value}`);
  return integer;
}

function parseRows(html) {
  const rows = [...html.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)].map((match) => match[1]);
  const dataRows = rows.filter((row) => /dmc_to_rgb_value\.php\?dmc=/i.test(row));
  if (dataRows.length < minimumRecordCount || dataRows.length > maximumRecordCount) {
    throw new Error(`Expected ${minimumRecordCount}-${maximumRecordCount} DMC rows, found ${dataRows.length}.`);
  }
  if (dataRows.length !== expectedRecordCount) throw new Error(`Expected exactly ${expectedRecordCount} DMC rows from the captured source, found ${dataRows.length}.`);
  const sevenCellRows = rows.filter((row) => (row.match(/<TD\b/gi) ?? []).length === 7);
  if (sevenCellRows.length !== dataRows.length) throw new Error(`Found ${sevenCellRows.length} seven-cell rows but ${dataRows.length} DMC rows; refusing to ignore malformed table rows.`);

  const records = [];
  const seenCodes = new Set();
  const seenSourceIds = new Set();
  const seenHex = new Set();
  const sourceRgbMismatches = [];

  for (const [rowNumber, row] of dataRows.entries()) {
    const cells = [...row.matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map((match) => match[1]);
    if (cells.length !== 7) throw new Error(`DMC row ${rowNumber + 1} has ${cells.length} cells; expected 7.`);

    const codeMatch = row.match(/dmc_to_rgb_value\.php\?dmc=([^"'&>]+)["'][^>]*>\s*([^<]+?)\s*<\/a>/i);
    if (!codeMatch) throw new Error(`DMC row ${rowNumber + 1} has no valid code link.`);
    const code = decodeEntities(codeMatch[1]).trim();
    const displayedCode = textContent(codeMatch[2]);
    if (!/^[0-9A-Za-z]+$/.test(code) || code !== displayedCode) throw new Error(`DMC row ${rowNumber + 1} has a malformed code.`);

    const name = textContent(cells[2]);
    if (!name) throw new Error(`DMC ${code} has an empty name.`);

    const hexMatches = [...cells[3].matchAll(/#([\da-f]{6})/gi)];
    if (hexMatches.length !== 1) throw new Error(`DMC ${code} has a malformed HEX value.`);
    const hex = `#${hexMatches[0][1].toUpperCase()}`;
    const styleHex = row.match(/background:\s*#([\da-f]{6})/i)?.[1]?.toUpperCase();
    if (styleHex !== hex.slice(1)) throw new Error(`DMC ${code} has inconsistent HEX cells.`);

    const sourceRgb = [
      parseIntegerCell(cells[4], `DMC ${code} red`),
      parseIntegerCell(cells[5], `DMC ${code} green`),
      parseIntegerCell(cells[6], `DMC ${code} blue`)
    ];
    const rgb = [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
    if (sourceRgb.some((value, index) => value !== rgb[index])) sourceRgbMismatches.push({ code, sourceRgb, hexRgb: rgb });

    const sourceId = `dmc-${code.toUpperCase()}`;
    if (seenCodes.has(code.toUpperCase())) throw new Error(`Duplicate DMC code: ${code}.`);
    if (seenSourceIds.has(sourceId)) throw new Error(`Duplicate source ID: ${sourceId}.`);
    if (seenHex.has(hex)) throw new Error(`Duplicate HEX value: ${hex}.`);
    seenCodes.add(code.toUpperCase());
    seenSourceIds.add(sourceId);
    seenHex.add(hex);
    records.push({ sourceId, code, name, hex, rgb });
  }

  return { records, sourceRgbMismatches, totalHtmlRows: rows.length };
}

function validateRecords(records) {
  if (records.length < minimumRecordCount || records.length > maximumRecordCount) throw new Error(`Normalized record count ${records.length} is outside the accepted range.`);
  const codes = new Set();
  const sourceIds = new Set();
  const hexes = new Set();
  for (const record of records) {
    if (!/^dmc-[0-9A-Z]+$/.test(record.sourceId) || record.sourceId !== `dmc-${record.code.toUpperCase()}`) throw new Error(`Invalid source ID for ${record.code}.`);
    if (!/^[0-9A-Za-z]+$/.test(record.code) || !record.name || !/^#[0-9A-F]{6}$/.test(record.hex)) throw new Error(`Malformed normalized record for ${record.code}.`);
    if (!Array.isArray(record.rgb) || record.rgb.length !== 3 || record.rgb.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error(`Invalid RGB for ${record.code}.`);
    const expectedRgb = [Number.parseInt(record.hex.slice(1, 3), 16), Number.parseInt(record.hex.slice(3, 5), 16), Number.parseInt(record.hex.slice(5, 7), 16)];
    if (record.rgb.some((value, index) => value !== expectedRgb[index])) throw new Error(`HEX/RGB mismatch for ${record.code}.`);
    if (codes.has(record.code.toUpperCase())) throw new Error(`Duplicate normalized code: ${record.code}.`);
    if (sourceIds.has(record.sourceId)) throw new Error(`Duplicate normalized source ID: ${record.sourceId}.`);
    if (hexes.has(record.hex)) throw new Error(`Duplicate normalized HEX: ${record.hex}.`);
    codes.add(record.code.toUpperCase());
    sourceIds.add(record.sourceId);
    hexes.add(record.hex);
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readExistingRetrievedAt(path, explicit) {
  if (explicit !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(explicit) || Number.isNaN(Date.parse(explicit))) throw new Error(`Invalid --retrieved-at timestamp: ${explicit}`);
    return explicit;
  }
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof current.snapshot?.retrievedAt === 'string') return current.snapshot.retrievedAt;
  }
  throw new Error('A new provenance file requires --retrieved-at in UTC ISO-8601 form.');
}

function build(args) {
  const html = readFileSync(args.input);
  const htmlText = html.toString('utf8');
  const parsed = parseRows(htmlText);
  validateRecords(parsed.records);
  const retrievedAt = readExistingRetrievedAt(args.provenance, args.retrievedAt);
  const catalog = {
    schemaVersion: 1,
    catalogId: 'dmc-compatible-screen-approximation',
    records: parsed.records
  };
  const catalogText = stableJson(catalog);
  const sourceSha256 = sha256(html);
  const provenance = {
    schemaVersion: 1,
    catalogId: catalog.catalogId,
    source: {
      repository: repositoryUrl,
      repositoryTree: repositoryTreeUrl,
      repositoryLicense: 'MIT',
      inspectedTreeSha: inspectedRepositorySha,
      upstreamDataUrl,
      runtimePolicy: 'The application reads only the committed normalized asset; it never fetches the upstream page.'
    },
    snapshot: {
      retrievedAt,
      htmlSha256: sourceSha256,
      dataSha256: sourceSha256,
      normalizedCatalogSha256: sha256(catalogText),
      observedHtmlTableRows: parsed.totalHtmlRows,
      observedDmcRecordCount: parsed.records.length,
      sourceRgbMismatchCount: parsed.sourceRgbMismatches.length,
      sourceRgbMismatches: parsed.sourceRgbMismatches
    },
    extraction: {
      parser: 'scripts/build-dmc-catalog.mjs',
      rules: [
        'Parse only local TR/TD rows containing dmc_to_rgb_value.php?dmc= links.',
        'Require 480-520 DMC data rows and exactly 489 rows from this captured source; reject any seven-cell table row that is not a DMC data row.',
        'Require seven cells, alphanumeric source code matching its link text, non-empty name, and matching style/link HEX values.',
        'Normalize source IDs to dmc-{CODE} with uppercase code while preserving the displayed code.',
        'Derive normalized RGB bytes from the validated six-digit HEX value so every committed record is internally consistent.',
        'Record, but do not silently use, upstream decimal RGB cells when they disagree with HEX; malformed values fail closed.',
        'Reject duplicate codes, source IDs, HEX values, malformed records, invalid RGB bytes, and HEX/RGB mismatches.'
      ],
      validation: 'Fail closed on missing, malformed, duplicate, out-of-range, or structurally unexpected records.'
    },
    status: {
      official: false,
      approximation: true,
      description: 'A DMC-compatible screen-color approximation derived from the captured upstream HEX table; not an official DMC color standard or colorimetric conversion.',
      dmcAffiliation: false,
      unresolvedUpstreamRightsWarning: 'The upstream page and its color/name data may carry rights or attribution obligations not resolved by this snapshot. Review upstream terms before redistribution or commercial use.'
    }
  };
  const expected = { catalog: catalogText, provenance: stableJson(provenance) };
  if (args.check) {
    const actualCatalog = readFileSync(args.output, 'utf8');
    const actualProvenance = readFileSync(args.provenance, 'utf8');
    if (actualCatalog !== expected.catalog) throw new Error(`Catalog is not reproducible: ${args.output}`);
    if (actualProvenance !== expected.provenance) throw new Error(`Provenance is not reproducible: ${args.provenance}`);
    return { catalog, provenance };
  }
  writeFileSync(args.output, expected.catalog);
  writeFileSync(args.provenance, expected.provenance);
  return { catalog, provenance };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = build(args);
  process.stdout.write(`${args.check ? 'Validated' : 'Wrote'} ${result.catalog.records.length} DMC records; HTML SHA-256 ${result.provenance.snapshot.htmlSha256}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

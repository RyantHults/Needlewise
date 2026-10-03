#!/usr/bin/env node
/**
 * Build the symbol pool from the vendored fonts and the authored selection.
 *
 * The authored file names codepoints and the font each one comes from; this
 * script resolves every entry against that font, extracts its outline, and
 * writes two committed artifacts. The selection may also carry per-glyph
 * adjustments (embolden, scale, offset), which are applied to the outline after
 * its extent is normalized. `--check` fails instead of writing, so a
 * stale artifact cannot reach a build.
 *
 * Everything here is deterministic: no timestamps, no random seeds, codepoints
 * and font slugs sorted in codepoint order, symbols emitted in distinctness
 * order. Nothing reads the clock, the locale, or the environment, so the
 * committed bytes are a pure function of the vendored fonts and selection.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NORMALIZATION, assignIds, buildSymbol, listCandidates, loadFont } from './lib/symbol-font.mjs';
import { FONTS_DIR, discoverFonts, toProvenance } from './lib/font-registry.mjs';
import { candidateKey, parseSelection, sortEntries } from './lib/selection.mjs';
import { parseAdjustments } from './lib/symbol-adjust.mjs';
import { orderByDistinctness } from './lib/symbol-distinctness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const SELECTION_PATH = resolve(REPO_ROOT, 'src/symbols/selection.json');
export const OUTPUT_PATH = resolve(REPO_ROOT, 'src/symbols/outlines.generated.json');
export const CANDIDATES_PATH = resolve(REPO_ROOT, 'src/symbols/candidates.generated.json');

/**
 * The schema version every committed symbol file carries.
 *
 * `selection.json`, `outlines.generated.json`, and `candidates.generated.json`
 * are bumped together, and the build refuses to run when the authored file
 * disagrees with this constant, so a pool can never be emitted under a schema
 * the runtime does not expect.
 */
export const ARTIFACT_VERSION = 3;
const STALE_MESSAGE = 'run: pnpm symbols:build';

export const readSelection = (path = SELECTION_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Resolve every selection entry to the candidate it names.
 *
 * An entry that does not resolve is an error rather than a skip: a selection
 * that quietly lost a glyph would render a pattern with a hole in it and no
 * signal that anything was wrong.
 */
export function selectCandidates(candidates, selection) {
  const catalog = new Map(
    candidates.map((candidate) => [candidateKey(candidate.font, candidate.codepoint), candidate])
  );
  const slugs = [...new Set(candidates.map((candidate) => candidate.font))];
  const seen = new Set();
  const chosen = [];

  for (const { font, codepoint } of parseSelection(selection)) {
    if (!slugs.includes(font)) {
      throw new Error(
        `The selection names the font "${font}", which is not in fonts/. `
        + `Discovered fonts: ${slugs.join(', ') || '(none)'}.`
      );
    }
    const key = candidateKey(font, codepoint);
    if (seen.has(key)) {
      throw new Error(`The selection lists ${key} twice.`);
    }
    seen.add(key);
    const candidate = catalog.get(key);
    if (!candidate) {
      throw new Error(`${font} has no drawable glyph at U+${codepoint.toString(16).toUpperCase()}.`);
    }
    chosen.push(candidate);
  }

  return chosen;
}

/**
 * Parsed fonts, keyed by path.
 *
 * A codepoint selected from two fonts must not parse the file twice, and a
 * check run has already parsed everything by the time it writes, so the cache
 * also keeps `--check` and a write to a temp dir from re-reading the fonts.
 */
const fontCache = new Map();

function loadFonts(registry) {
  return new Map(registry.map((record) => {
    if (!fontCache.has(record.absPath)) fontCache.set(record.absPath, loadFont(record.absPath));
    return [record.slug, fontCache.get(record.absPath)];
  }));
}

function allCandidates(registry, fonts) {
  return assignIds(registry.flatMap((record) => listCandidates(fonts.get(record.slug), record.slug)));
}

/**
 * Build the outline payload from the selection and the vendored fonts.
 *
 * `adjustments` maps a canonical entry to its parsed adjustment; an entry
 * without one is drawn as the font draws it. An adjustment that cannot be
 * applied fails with the entry it belongs to.
 */
export function buildOutlines(selection, registry, candidates, fonts, adjustments = new Map()) {
  const chosen = selectCandidates(candidates, selection);
  const usedFonts = new Set(chosen.map((candidate) => candidate.font));

  const entries = chosen.map((candidate) => {
    const adjustment = adjustments.get(candidateKey(candidate.font, candidate.codepoint));
    let entry;
    try {
      ({ entry } = buildSymbol(fonts.get(candidate.font), candidate, NORMALIZATION, adjustment));
    } catch (error) {
      if (!adjustment) throw error;
      throw new Error(`The adjustment for ${candidateKey(candidate.font, candidate.codepoint)} failed: ${error.message}`, { cause: error });
    }
    return { id: candidate.id, ...entry, font: candidate.font };
  });

  // Palette id N is auto-assigned the Nth pooled symbol, so each next symbol is
  // the one least like everything before it.
  const ordered = orderByDistinctness(entries, { tileView: NORMALIZATION.tileView });
  const symbols = {};
  for (const { id, name, block, codepoint, font, d } of ordered) {
    symbols[id] = { name, block, codepoint, font, d };
  }

  const fontsOut = {};
  for (const record of registry) {
    if (usedFonts.has(record.slug)) fontsOut[record.slug] = toProvenance(record);
  }

  return {
    version: ARTIFACT_VERSION,
    fonts: fontsOut,
    tileView: NORMALIZATION.tileView,
    generated: Object.keys(symbols).length,
    symbols
  };
}

/** Build the full candidate list the dev picker browses. */
export function buildCandidates(registry, candidates) {
  const fonts = {};
  for (const record of registry) {
    fonts[record.slug] = { family: record.family, file: record.file };
  }
  return {
    version: ARTIFACT_VERSION,
    fonts,
    total: candidates.length,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      font: candidate.font,
      codepoint: candidate.codepoint,
      name: candidate.name,
      block: candidate.block
    }))
  };
}

/** Serialise with a trailing newline so the file is POSIX-clean. */
export const serialize = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

/**
 * Write one artifact, or verify the committed copy already matches.
 *
 * Check mode throws rather than returning a flag, so a stale artifact is
 * reported with the reason instead of a bare exit code.
 */
export function writeOrCheck(path, payload, label, check) {
  const body = serialize(payload);
  if (check) {
    let current;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`${label} is missing; ${STALE_MESSAGE}`);
    }
    if (current !== body) throw new Error(`${label} is stale; ${STALE_MESSAGE}`);
    return;
  }
  writeFileSync(path, body);
}

/**
 * Build, or with `--check` verify, the two committed artifacts.
 *
 * `paths` redirects every file the run reads or writes, and `log` takes the
 * line it reports, so a test can exercise check mode against a temp dir without
 * touching what ships or printing the paths. Both default to the repository and
 * to stdout, which is the only way the script is ever run for real.
 */
export function main(argv, paths = {}) {
  const selectionPath = paths.selectionPath ?? SELECTION_PATH;
  const outputDir = paths.outputDir ?? dirname(OUTPUT_PATH);
  const log = paths.log ?? ((line) => process.stdout.write(line));
  const check = argv.includes('--check');
  const selection = readSelection(selectionPath);
  if (selection.version !== ARTIFACT_VERSION) {
    throw new Error(
      `selection.json is version ${selection.version} but this build emits version ${ARTIFACT_VERSION}. `
      + 'The three symbol files move together, so bump all of them in one change.'
    );
  }
  const registry = discoverFonts(FONTS_DIR);
  if (registry.length === 0) throw new Error(`No fonts were found in ${FONTS_DIR}.`);
  const fonts = loadFonts(registry);
  const candidates = allCandidates(registry, fonts);

  const sorted = sortEntries(selection.selection);
  const adjustments = parseAdjustments(selection.adjustments, sorted);
  const outlines = buildOutlines(sorted, registry, candidates, fonts, adjustments);
  const catalog = buildCandidates(registry, candidates);

  writeOrCheck(resolve(outputDir, 'outlines.generated.json'), outlines, 'outlines.generated.json', check);
  writeOrCheck(resolve(outputDir, 'candidates.generated.json'), catalog, 'candidates.generated.json', check);

  const fontCount = Object.keys(outlines.fonts).length;
  const plural = fontCount === 1 ? '' : 's';
  const line = check
    ? `symbol outlines are up to date: ${outlines.generated} symbols from ${catalog.total} candidates`
    : `wrote ${outlines.generated} symbol outlines to ${resolve(outputDir, 'outlines.generated.json')} `
      + `and ${catalog.total} candidates to ${resolve(outputDir, 'candidates.generated.json')}`;
  log(`${line} across ${fontCount} font${plural}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

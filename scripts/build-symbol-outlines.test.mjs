import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ARTIFACT_VERSION,
  CANDIDATES_PATH,
  OUTPUT_PATH,
  SELECTION_PATH,
  buildCandidates,
  buildOutlines,
  interleaveByBlock,
  main,
  readSelection,
  selectCandidates
} from './build-symbol-outlines.mjs';
import { discoverFonts, FONTS_DIR } from './lib/font-registry.mjs';
import { NORMALIZATION, loadFont, listCandidates } from './lib/symbol-font.mjs';
import { candidateKey } from './lib/selection.mjs';

const tempDirs = [];
/** Temp-dir runs report through `log`; a test does not want its stdout. */
const SILENT = { log: () => {} };
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symbols-build-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const registry = discoverFonts(FONTS_DIR);
const fonts = new Map(registry.map((record) => [record.slug, loadFont(record.absPath)]));
const candidates = registry.flatMap((record) => listCandidates(fonts.get(record.slug), record.slug));
const catalog = new Map(candidates.map((c) => [candidateKey(c.font, c.codepoint), c]));

/**
 * The pool every runtime test reads, and the selection it is built from.
 *
 * The curated pool is the user's to change, so nothing in the test suite is
 * written against it. These two files are what the alias in vite.config.ts
 * swaps the runtime artifact for, which is why the fixture artifact has to stay
 * reproducible from the fixture selection like the committed one does.
 */
const FIXTURE_SELECTION_PATH = resolve(import.meta.dirname, '../src/symbols/selection.fixture.json');
const FIXTURE_OUTLINE_PATH = resolve(import.meta.dirname, '../src/symbols/outlines.fixture.generated.json');
const fixtureSelection = () => JSON.parse(readFileSync(FIXTURE_SELECTION_PATH, 'utf8')).selection;

const libertinus = registry[0].slug;
const key = (cp) => `${libertinus}:U+${cp.toString(16).toUpperCase()}`;
const heart = 0x2665;

describe('selectCandidates', () => {
  it('resolves an empty selection to an empty pool', () => {
    // A selection is authored by hand and may name no glyphs, which is a pool
    // with nothing in it rather than a selection that went wrong. The check that
    // an entry resolves is about the entries there are.
    expect(selectCandidates(candidates, [])).toEqual([]);
  });

  it('resolves an entry against the font it names', () => {
    const [chosen] = selectCandidates(candidates, [key(heart)]);
    expect(chosen.codepoint).toBe(heart);
    expect(chosen.font).toBe(libertinus);
  });

  it('gives one codepoint from two fonts two distinct ids', () => {
    if (registry.length < 2) return;
    const both = candidates.filter((c) => c.codepoint === heart).map((c) => c.font);
    expect(new Set(both).size).toBeGreaterThanOrEqual(2);
    const chosen = selectCandidates(candidates, both.map((f) => `${f}:U+2665`));
    expect(new Set(chosen.map((c) => c.id)).size).toBe(chosen.length);
  });

  it('names the valid slugs when an entry names an unknown font', () => {
    expect(() => selectCandidates(candidates, ['no-such-font:U+2665']))
      .toThrow(new RegExp(libertinus));
  });

  it('names the font and codepoint when the font lacks the codepoint', () => {
    expect(() => selectCandidates(candidates, [`${libertinus}:U+10FFFD`]))
      .toThrow(new RegExp('U\\+10FFFD'));
  });

  it('rejects a duplicate entry', () => {
    expect(() => selectCandidates(candidates, [key(heart), key(heart)])).toThrow(/twice|duplicate/i);
  });

  it('never resolves a codepoint from a different font', () => {
    const other = registry[1]?.slug;
    if (!other) return;
    const onlyInFirst = candidates.find(
      (c) => c.font === libertinus && !catalog.has(candidateKey(other, c.codepoint))
    );
    if (!onlyInFirst) return;
    expect(() => selectCandidates(candidates, [candidateKey(other, onlyInFirst.codepoint)])).toThrow();
  });
});

describe('interleaveByBlock', () => {
  it('places the variants of one codepoint next to each other', () => {
    const variants = [
      { id: 'a--heart', name: 'heart', block: 'Miscellaneous Symbols', codepoint: heart, font: 'a', d: '' },
      { id: 'b--heart', name: 'heart', block: 'Miscellaneous Symbols', codepoint: heart, font: 'b', d: '' },
      { id: 'a--star', name: 'star', block: 'Miscellaneous Symbols', codepoint: 0x2605, font: 'a', d: '' }
    ];
    const ordered = interleaveByBlock(variants).map((s) => s.id);
    expect(ordered.indexOf('a--heart')).toBe(ordered.indexOf('b--heart') - 1);
  });

  it('only repeats a block after every other block is exhausted', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`, name: `n${i}`, block: 'A', codepoint: i, font: 'x', d: ''
    }));
    const ordered = interleaveByBlock([...many, { id: 'y', name: 'y', block: 'B', codepoint: 0, font: 'y', d: '' }]);
    expect(ordered.map((s) => s.block)).toEqual(['A', 'B', 'A', 'A', 'A', 'A', 'A']);
  });

  it('accepts a selection drawn from a single block', () => {
    const only = Array.from({ length: 4 }, (_, i) => ({
      id: `x${i}`, name: `n${i}`, block: 'A', codepoint: i, font: 'x', d: ''
    }));
    expect(interleaveByBlock(only)).toHaveLength(4);
  });

  it('orders the fonts of one codepoint by codepoint, not by collation', () => {
    // Which face of a glyph comes first lands in the committed artifact, and
    // the host's ICU is not part of its inputs.
    const variants = [
      { id: 'b--heart', name: 'heart', block: 'A', codepoint: heart, font: 'b', d: '' },
      { id: 'a-b--heart', name: 'heart', block: 'A', codepoint: heart, font: 'a-b', d: '' },
      { id: 'ab--heart', name: 'heart', block: 'A', codepoint: heart, font: 'ab', d: '' }
    ];
    const real = String.prototype.localeCompare;
    String.prototype.localeCompare = function reversed(other) {
      return other < this ? -1 : other > this ? 1 : 0;
    };
    try {
      expect(interleaveByBlock(variants).map((s) => s.id)).toEqual([
        'a-b--heart', 'ab--heart', 'b--heart'
      ]);
    } finally {
      String.prototype.localeCompare = real;
    }
  });

  it('breaks a tie between equal-sized blocks by Map insertion order', () => {
    // Two blocks of the same size have no fuller candidate, so the first one
    // the walk reaches wins. Insertion order is the order the sorted selection
    // first mentions each block, which is a pure function of selection.json:
    // adding a font can move a block in the pool, but two runs of the same
    // selection always agree.
    const symbols = [
      { id: 'z0', name: 'z0', block: 'Zebra', codepoint: 1, font: 'z', d: '' },
      { id: 'a0', name: 'a0', block: 'Alpha', codepoint: 1, font: 'a', d: '' }
    ];
    expect(interleaveByBlock(symbols).map((s) => s.id)).toEqual(['z0', 'a0']);
    expect(interleaveByBlock([...symbols].reverse()).map((s) => s.id)).toEqual(['a0', 'z0']);
  });
});

describe('schema version lockstep', () => {
  it('is the version selection.json records', () => {
    expect(readSelection().version).toBe(ARTIFACT_VERSION);
  });

  it('refuses to build when selection.json is on another version', () => {
    // The lockstep is only a guarantee if something compares the two numbers.
    // Bumping the authored file alone would otherwise emit a pool the runtime
    // reads under the wrong schema, with no failure anywhere.
    const dir = tempDir();
    const selectionPath = join(dir, 'selection.json');
    writeFileSync(selectionPath, JSON.stringify({ version: ARTIFACT_VERSION + 1, selection: [] }));
    expect(() => main([], { selectionPath, outputDir: dir, ...SILENT }))
      .toThrow(new RegExp(`selection.json is version ${ARTIFACT_VERSION + 1}`));
  });

  it('names the version the build emits when they disagree', () => {
    const dir = tempDir();
    const selectionPath = join(dir, 'selection.json');
    writeFileSync(selectionPath, JSON.stringify({ version: ARTIFACT_VERSION + 1, selection: [] }));
    expect(() => main([], { selectionPath, outputDir: dir, ...SILENT }))
      .toThrow(new RegExp(`emits version ${ARTIFACT_VERSION}`));
  });

  it('writes nothing when the versions disagree', () => {
    const dir = tempDir();
    const selectionPath = join(dir, 'selection.json');
    writeFileSync(selectionPath, JSON.stringify({ version: ARTIFACT_VERSION + 1, selection: [] }));
    expect(() => main([], { selectionPath, outputDir: dir, ...SILENT })).toThrow();
    expect(existsSync(join(dir, 'outlines.generated.json'))).toBe(false);
  });
});

describe('check mode', () => {
  // Check mode is about the bytes on disk against the bytes the build produces,
  // so a one-symbol selection exercises the same path in a fraction of the
  // time. The one symbol comes from the test fixture pool rather than the
  // curated one, so the cost and the shape of this suite do not depend on what
  // the pool currently holds.
  const ONE = () => [fixtureSelection()[0]];
  const ALL = () => JSON.parse(readFileSync(SELECTION_PATH, 'utf8')).selection;

  /** Build once into a temp dir; every case below copies or perturbs that. */
  const build = (selection) => {
    const dir = tempDir();
    const selectionPath = join(dir, 'selection.json');
    writeFileSync(selectionPath, JSON.stringify({ version: ARTIFACT_VERSION, selection }));
    main([], { selectionPath, outputDir: dir, ...SILENT });
    return { dir, selectionPath };
  };
  const perturb = (source, edits) => {
    const dir = tempDir();
    for (const name of readdirSync(source.dir)) cpSync(join(source.dir, name), join(dir, name));
    edits(dir);
    return { dir, selectionPath: join(dir, 'selection.json') };
  };

  it('reports a missing artifact', () => {
    // `symbols:check` runs in CI, so a deleted artifact has to fail loudly
    // rather than being recreated where nobody looks.
    const dir = perturb(build(ONE()), (d) => rmSync(join(d, 'outlines.generated.json')));
    expect(() => main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT }))
      .toThrow(/outlines.generated.json is missing/);
  });

  it('reports a stale artifact', () => {
    const dir = perturb(build(ONE()), (d) => {
      writeFileSync(join(d, 'outlines.generated.json'), '{ "version": 3, "symbols": {} }\n');
    });
    expect(() => main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT }))
      .toThrow(/outlines.generated.json is stale/);
  });

  it('reports a stale candidate catalog too', () => {
    const dir = perturb(build(ONE()), (d) => {
      writeFileSync(join(d, 'candidates.generated.json'), '{ "version": 3, "candidates": [] }\n');
    });
    expect(() => main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT }))
      .toThrow(/candidates.generated.json is stale/);
  });

  it('passes when the artifacts on disk are the ones the build produces', () => {
    const dir = build(ONE());
    expect(() => main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT }))
      .not.toThrow();
  });

  it('does not rewrite what it just accepted', () => {
    const dir = build(ONE());
    const snapshot = () => readdirSync(dir.dir).map((n) => [n, readFileSync(join(dir.dir, n), 'utf8')]);
    const before = snapshot();
    main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT });
    expect(snapshot()).toEqual(before);
  });

  it('reproduces the committed bytes from the committed selection', () => {
    const dir = perturb(build(ALL()), () => {});
    main([], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT });
    expect(readFileSync(join(dir.dir, 'outlines.generated.json'), 'utf8'))
      .toBe(readFileSync(OUTPUT_PATH, 'utf8'));
    expect(readFileSync(join(dir.dir, 'candidates.generated.json'), 'utf8'))
      .toBe(readFileSync(CANDIDATES_PATH, 'utf8'));
  }, 30_000);

  it('leaves the committed artifacts alone', () => {
    // The temp-dir options exist so no test can overwrite what ships.
    const before = [OUTPUT_PATH, CANDIDATES_PATH].map((path) => readFileSync(path, 'utf8'));
    const dir = build(ONE());
    main([], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT });
    main(['--check'], { selectionPath: dir.selectionPath, outputDir: dir.dir, ...SILENT });
    expect([OUTPUT_PATH, CANDIDATES_PATH].map((path) => readFileSync(path, 'utf8'))).toEqual(before);
  });
});

describe('the test fixture pool', () => {
  // The whole runtime suite is written against this pool, so the two properties
  // it needs are asserted here: it is drawn from every vendored font, so a test
  // can still see a symbol a second font contributed, and more than one font
  // contributes one name, so a test can still see a shared one. An artifact
  // that lost either would leave those tests quietly asserting nothing.
  it('draws from every vendored font', () => {
    const fonts = new Set(fixtureSelection().map((entry) => entry.slice(0, entry.indexOf(':'))));
    expect([...fonts].sort()).toEqual(registry.map((record) => record.slug).sort());
  });

  it('shares a Unicode name between two fonts', () => {
    const byName = new Map();
    for (const entry of Object.values(JSON.parse(readFileSync(FIXTURE_OUTLINE_PATH, 'utf8')).symbols)) {
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.font]);
    }
    expect([...byName.values()].filter((variants) => new Set(variants).size > 1).length)
      .toBeGreaterThan(0);
  });

  it('holds enough symbols for a test to reach past the first few', () => {
    expect(fixtureSelection().length).toBeGreaterThanOrEqual(4);
  });

  it('reproduces the committed bytes from the committed selection', () => {
    // Editing the fixture selection without rebuilding the fixture artifact
    // would leave every runtime test reading geometry that no longer matches the
    // selection it is named after.
    const dir = tempDir();
    main([], { selectionPath: FIXTURE_SELECTION_PATH, outputDir: dir, ...SILENT });
    expect(readFileSync(join(dir, 'outlines.generated.json'), 'utf8'))
      .toBe(readFileSync(FIXTURE_OUTLINE_PATH, 'utf8'));
  }, 30_000);
});

describe('buildOutlines', () => {
  it('emits an empty pool for an empty selection', () => {
    // The pool is whatever the selection holds, so the artifact of a selection
    // that names nothing is an artifact with nothing in it: no symbols, and no
    // font provenance either, since no glyph came from one.
    expect(buildOutlines([], registry, candidates, fonts)).toEqual({
      version: ARTIFACT_VERSION,
      fonts: {},
      tileView: NORMALIZATION.tileView,
      generated: 0,
      symbols: {}
    });
  });

  it('records a font field on every symbol', () => {
    const payload = buildOutlines([key(heart)], registry, candidates, fonts);
    const [entry] = Object.values(payload.symbols);
    expect(entry.font).toBe(libertinus);
  });

  it('lists only the fonts a selected symbol uses', () => {
    const payload = buildOutlines([key(heart)], registry, candidates, fonts);
    expect(Object.keys(payload.fonts)).toEqual([libertinus]);
  });

  it('records provenance for a used font', () => {
    const payload = buildOutlines([key(heart)], registry, candidates, fonts);
    const provenance = payload.fonts[libertinus];
    expect(provenance.family).toBe('Libertinus Math');
    expect(provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.licenseUrl).toBeTruthy();
    expect(provenance).not.toHaveProperty('absPath');
  });

  it('keys every symbol by a font-qualified id', () => {
    const payload = buildOutlines([key(heart)], registry, candidates, fonts);
    expect(Object.keys(payload.symbols).every((id) => id.includes('--'))).toBe(true);
  });

  it('counts the symbols it generated', () => {
    const two = registry.slice(0, 2).map((record) => {
      const first = candidates.find((c) => c.font === record.slug);
      return candidateKey(record.slug, first.codepoint);
    });
    const payload = buildOutlines(two, registry, candidates, fonts);
    expect(payload.generated).toBe(Object.keys(payload.symbols).length);
  });

  it('builds a selection drawn from more than one font', () => {
    if (registry.length < 2) return;
    const perFont = registry.map((r) => {
      const first = candidates.find((c) => c.font === r.slug);
      return candidateKey(r.slug, first.codepoint);
    });
    const payload = buildOutlines(perFont, registry, candidates, fonts);
    expect(Object.keys(payload.fonts).sort()).toEqual(registry.map((r) => r.slug).sort());
  });
});

describe('buildCandidates', () => {
  it('lists every discovered font', () => {
    const payload = buildCandidates(registry, candidates);
    expect(Object.keys(payload.fonts).sort()).toEqual(registry.map((r) => r.slug).sort());
  });

  it('totals the candidates across all fonts', () => {
    const payload = buildCandidates(registry, candidates);
    expect(payload.total).toBe(candidates.length);
  });

  it('gives every candidate a unique font-qualified id', () => {
    const payload = buildCandidates(registry, candidates);
    const ids = payload.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.includes('--'))).toBe(true);
  });

  it('tags every candidate with the font it came from', () => {
    const payload = buildCandidates(registry, candidates);
    expect(payload.candidates.every((c) => registry.some((r) => r.slug === c.font))).toBe(true);
  });
});

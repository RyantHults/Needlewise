import { describe, expect, it } from 'vitest';

import {
  buildCandidates, buildOutlines, interleaveByBlock, selectCandidates
} from './build-symbol-outlines.mjs';
import { discoverFonts, FONTS_DIR } from './lib/font-registry.mjs';
import { loadFont, listCandidates } from './lib/symbol-font.mjs';
import { candidateKey } from './lib/selection.mjs';

const registry = discoverFonts(FONTS_DIR);
const fonts = new Map(registry.map((record) => [record.slug, loadFont(record.absPath)]));
const candidates = registry.flatMap((record) => listCandidates(fonts.get(record.slug), record.slug));
const catalog = new Map(candidates.map((c) => [candidateKey(c.font, c.codepoint), c]));

const libertinus = registry[0].slug;
const key = (cp) => `${libertinus}:U+${cp.toString(16).toUpperCase()}`;
const heart = 0x2665;

describe('selectCandidates', () => {
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
});

describe('buildOutlines', () => {
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

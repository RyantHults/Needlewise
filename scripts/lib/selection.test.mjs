import { describe, expect, it } from 'vitest';

import {
  candidateKey, formatEntry, parseEntry, parseSelection, sortEntries
} from './selection.mjs';

describe('formatEntry', () => {
  it('joins a font slug and a codepoint', () => {
    expect(formatEntry('libertinus-math', 0x20a2)).toBe('libertinus-math:U+20A2');
  });

  it('pads a codepoint below four digits', () => {
    expect(formatEntry('x', 0x21)).toBe('x:U+0021');
  });

  it('keeps a codepoint above four digits intact', () => {
    expect(formatEntry('x', 0x1f52c)).toBe('x:U+1F52C');
  });
});

describe('candidateKey', () => {
  it('is the entry text, so a catalog and a selection agree', () => {
    expect(candidateKey('libertinus-math', 0x20a2)).toBe(formatEntry('libertinus-math', 0x20a2));
  });
});

describe('parseEntry', () => {
  it('splits a valid entry', () => {
    expect(parseEntry('noto-sans-symbols-2:U+1F52C'))
      .toEqual({ font: 'noto-sans-symbols-2', codepoint: 0x1f52c });
  });

  it('accepts a lowercase prefix and lowercase hex', () => {
    expect(parseEntry('libertinus-math:u+20a2')).toEqual({ font: 'libertinus-math', codepoint: 0x20a2 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseEntry('  libertinus-math:U+2665  ')).toEqual({ font: 'libertinus-math', codepoint: 0x2665 });
  });

  it('names the entry when it has no font', () => {
    expect(() => parseEntry('U+2665')).toThrow(/U\+2665/);
  });

  it('names the entry when it has no codepoint', () => {
    expect(() => parseEntry('libertinus-math:')).toThrow(/libertinus-math:/);
  });

  it('names the entry when the codepoint is not hex', () => {
    expect(() => parseEntry('libertinus-math:U+ZZZZ')).toThrow(/U\+ZZZZ/);
  });

  it('rejects a codepoint beyond the Unicode range', () => {
    expect(() => parseEntry('x:U+110000')).toThrow(/U\+110000/);
  });

  it('rejects a font slug containing the id separator', () => {
    expect(() => parseEntry('bad--slug:U+2665')).toThrow(/separates a font from a glyph/);
  });

  it('rejects a slug that is not url safe', () => {
    expect(() => parseEntry('Bad Slug:U+2665')).toThrow(/Bad Slug/);
  });
});

describe('parseSelection', () => {
  it('parses every entry', () => {
    expect(parseSelection(['a:U+0061', 'b:U+0062'])).toEqual([
      { font: 'a', codepoint: 0x61 },
      { font: 'b', codepoint: 0x62 }
    ]);
  });

  it('names the entry that failed', () => {
    expect(() => parseSelection(['a:U+0061', 'nope'])).toThrow(/nope/);
  });

  it('rejects a value that is not a list', () => {
    expect(() => parseSelection('a:U+0061')).toThrow(/list/);
  });
});

describe('sortEntries', () => {
  it('sorts by font, then codepoint', () => {
    const sorted = sortEntries([
      'noto-sans-symbols-2:U+1F52C',
      'libertinus-math:U+2665',
      'libertinus-math:U+20A2'
    ]);
    expect(sorted).toEqual([
      'libertinus-math:U+20A2',
      'libertinus-math:U+2665',
      'noto-sans-symbols-2:U+1F52C'
    ]);
  });

  it('normalises each entry as it sorts', () => {
    expect(sortEntries(['b:U+0061', 'a:U+0061'])).toEqual(['a:U+0061', 'b:U+0061']);
  });

  it('does not mutate its input', () => {
    const input = ['b:U+0061', 'a:U+0061'];
    sortEntries(input);
    expect(input).toEqual(['b:U+0061', 'a:U+0061']);
  });
});

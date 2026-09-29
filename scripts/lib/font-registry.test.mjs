import { describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { discoverFonts, slugForFamily, toProvenance } from './font-registry.mjs';
import { loadFont } from './symbol-font.mjs';

const REPO_FONT = resolve(import.meta.dirname, '../../fonts/LibertinusMath-Regular.ttf');

const scratch = () => mkdtempSync(join(tmpdir(), 'font-registry-'));

describe('discoverFonts', () => {
  it('derives a record for every font file in the directory', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'LibertinusMath-Regular.ttf'));
    const [record] = discoverFonts(dir);
    expect(record.family).toBe('Libertinus Math');
    expect(record.slug).toBe('libertinus-math');
    expect(record.unitsPerEm).toBe(1000);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.licenseUrl).toMatch(/openfontlicense\.org|scripts\.sil\.org\/OFL/);
    expect(record.drawableCodepoints).toBe(3626);
  });

  it('reads the family name from the windows name table, not the filename', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'renamed-by-the-user.ttf'));
    const [record] = discoverFonts(dir);
    expect(record.family).toBe('Libertinus Math');
    expect(record.slug).toBe('libertinus-math');
  });

  it('rejects a file that is not a font, naming it', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'not-a-font.ttf'), 'this is not a font');
    expect(() => discoverFonts(dir)).toThrow(/not-a-font\.ttf/);
  });

  it('ignores files that are not fonts by extension', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'LibertinusMath-Regular.ttf'));
    writeFileSync(join(dir, 'OFL.txt'), 'license text');
    expect(discoverFonts(dir)).toHaveLength(1);
  });

  it('reports fewer drawable codepoints than the font maps', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'LibertinusMath-Regular.ttf'));
    const [record] = discoverFonts(dir);
    const font = loadFont(record.absPath);
    const mapped = Object.keys(font.tables.cmap.glyphIndexMap).length;
    expect(record.drawableCodepoints).toBeLessThan(mapped);
  });

  it('returns records in a stable filename order', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'zzz.ttf'));
    copyFileSync(REPO_FONT, join(dir, 'aaa.ttf'));
    const files = discoverFonts(dir).map((record) => record.file);
    expect(files).toEqual([...files].sort());
  });

  it('gives two files reporting the same family different slugs', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'first.ttf'));
    copyFileSync(REPO_FONT, join(dir, 'second.ttf'));
    const slugs = discoverFonts(dir).map((record) => record.slug);
    expect(slugs).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);
  });

  it('records an absolute path for a font from outside the repository', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'LibertinusMath-Regular.ttf'));
    const [record] = discoverFonts(dir);
    expect(record.file.startsWith('/')).toBe(true);
  });

  it('records a repo-relative path for a font in fonts/', () => {
    const record = discoverFonts().find((entry) => entry.file.endsWith('LibertinusMath-Regular.ttf'));
    expect(record).toBeDefined();
    expect(record.file).toBe('fonts/LibertinusMath-Regular.ttf');
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(discoverFonts(join(tmpdir(), 'font-registry-missing-dir'))).toEqual([]);
  });
});

describe('toProvenance', () => {
  it('keeps the recorded fields and drops the machine-local path', () => {
    const dir = scratch();
    copyFileSync(REPO_FONT, join(dir, 'LibertinusMath-Regular.ttf'));
    const [record] = discoverFonts(dir);
    const provenance = toProvenance(record);
    expect(provenance).not.toHaveProperty('absPath');
    expect(provenance).toHaveProperty('family');
    expect(provenance).toHaveProperty('sha256');
    expect(provenance).toHaveProperty('unitsPerEm');
    expect(provenance).toHaveProperty('version');
    expect(provenance).toHaveProperty('licenseUrl');
    expect(provenance).toHaveProperty('drawableCodepoints');
  });
});

describe('slugForFamily', () => {
  it('lowerases and hyphenates a family name', () => {
    expect(slugForFamily('Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf', new Set()))
      .toBe('noto-sans-symbols-2');
  });

  it('never produces a double hyphen', () => {
    expect(slugForFamily('Foo  --  Bar', 'x.ttf', new Set())).not.toContain('--');
  });

  it('suffixes a slug that is already taken', () => {
    const taken = new Set(['libertinus-math']);
    expect(slugForFamily('Libertinus Math', 'other.ttf', taken)).toBe('libertinus-math-2');
    taken.add('libertinus-math-2');
    expect(slugForFamily('Libertinus Math', 'third.ttf', taken)).toBe('libertinus-math-3');
  });

  it('falls back to the filename when the family name has no alphanumerics', () => {
    expect(slugForFamily('---', 'Symbol-Font.ttf', new Set())).toBe('symbol-font');
  });
});

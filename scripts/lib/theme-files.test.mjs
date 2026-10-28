import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BASE_GROUP_TITLE,
  addRegistryEntry,
  applyThemeEdits,
  duplicateTheme,
  readRegistry,
  readTheme,
  removeRegistryEntry,
  updateRegistryEntry
} from './theme-files.mjs';

const THEMES_DIR = 'src/themes';
const themeText = (id) => readFileSync(join(THEMES_DIR, `${id}.css`), 'utf8');
const registryText = readFileSync('src/components/app-theme.ts', 'utf8');

const valuesOf = (theme) =>
  Object.fromEntries(theme.groups.flatMap((group) => group.tokens.map(({ name, value }) => [name, value])));

describe('readTheme', () => {
  it('reads the selector, colour scheme and commented groups of a theme', () => {
    const theme = readTheme(themeText('nord'));
    expect(theme.selector).toBe(':root[data-theme="nord"], [data-theme-preview="nord"]');
    expect(theme.colorScheme).toBe('dark');
    expect(theme.groups[0].title).toBe(BASE_GROUP_TITLE);
    expect(theme.groups[0].tokens).toContainEqual({ name: '--nord-accent', value: 'var(--nord-nord8)' });
    const surfaces = theme.groups.find((group) => group.title === 'Surfaces');
    expect(surfaces.tokens).toContainEqual({ name: '--color-page', value: 'var(--nord-nord0)' });
  });

  it('reads the default theme, which declares no colour scheme', () => {
    const theme = readTheme(themeText('needlewise'));
    expect(theme.colorScheme).toBeNull();
    expect(theme.groups[0].title).toBe('Surfaces');
  });
});

describe('applyThemeEdits', () => {
  it('writes every theme back byte for byte when given its own values', () => {
    for (const file of readdirSync(THEMES_DIR)) {
      const cssText = readFileSync(join(THEMES_DIR, file), 'utf8');
      const theme = readTheme(cssText);
      expect(applyThemeEdits(cssText, { colorScheme: theme.colorScheme, values: valuesOf(theme) }), file)
        .toBe(cssText);
    }
  });

  it('changes only the edited values and the colour scheme', () => {
    const cssText = themeText('nord');
    const edited = applyThemeEdits(cssText, {
      colorScheme: 'light',
      values: { '--color-page': '#123456', '--nord-accent': 'var(--nord-nord9)' }
    });
    const theme = readTheme(edited);
    expect(theme.colorScheme).toBe('light');
    expect(valuesOf(theme)).toEqual({
      ...valuesOf(readTheme(cssText)),
      '--color-page': '#123456',
      '--nord-accent': 'var(--nord-nord9)'
    });
    expect(edited.split('\n')).toHaveLength(cssText.split('\n').length);
  });

  it('refuses a property the theme does not declare', () => {
    expect(() => applyThemeEdits(themeText('nord'), { colorScheme: 'dark', values: { '--color-new': 'red' } }))
      .toThrow('--color-new');
  });

  it('refuses a value that is not exactly one declaration value', () => {
    for (const value of ['red; --color-ink: blue', 'red } body { color: red', '']) {
      expect(() => applyThemeEdits(themeText('nord'), { colorScheme: 'dark', values: { '--color-page': value } }))
        .toThrow('--color-page');
    }
  });

  it('never adds or removes a colour scheme', () => {
    expect(() => applyThemeEdits(themeText('needlewise'), { colorScheme: 'dark', values: {} })).toThrow();
    expect(() => applyThemeEdits(themeText('nord'), { colorScheme: null, values: {} })).toThrow();
  });
});

describe('duplicateTheme', () => {
  it('renames the selector pair and the header, keeping every value', () => {
    const cssText = themeText('nord');
    const copy = duplicateTheme(cssText, { id: 'nord-frost', label: 'Nord Frost' });
    expect(copy.startsWith('/* Nord Frost. */\n')).toBe(true);
    const theme = readTheme(copy);
    expect(theme.selector).toBe(':root[data-theme="nord-frost"], [data-theme-preview="nord-frost"]');
    expect(theme.groups).toEqual(readTheme(cssText).groups);
  });
});

describe('the registry', () => {
  it('reads every entry in order', () => {
    const registry = readRegistry(registryText);
    expect(registry[0]).toEqual({ id: 'needlewise', label: 'Needlewise', group: 'Needlewise' });
    expect(registry.map((entry) => entry.id)).toContain('rose-pine-main');
  });

  it('adds an entry after its group, and removing it restores the text', () => {
    const entry = { id: 'nord-frost', label: 'Nord "Frost"', group: 'Nord' };
    const added = addRegistryEntry(registryText, entry);
    const ids = readRegistry(added).map((option) => option.id);
    expect(ids[ids.indexOf('nord') + 1]).toBe('nord-frost');
    expect(readRegistry(added)).toContainEqual(entry);
    expect(removeRegistryEntry(added, 'nord-frost')).toBe(registryText);
  });

  it('adds an entry with a new group at the end', () => {
    const added = addRegistryEntry(registryText, { id: 'paper', label: 'Paper', group: 'Paper' });
    expect(readRegistry(added).at(-1)).toEqual({ id: 'paper', label: 'Paper', group: 'Paper' });
    expect(() => addRegistryEntry(added, { id: 'paper', label: 'Paper', group: 'Paper' })).toThrow('paper');
  });

  it('updates an entry in place', () => {
    const updated = updateRegistryEntry(registryText, 'nord', { label: 'Nord Polar', group: 'Arctic' });
    const before = readRegistry(registryText);
    expect(readRegistry(updated)).toEqual(before.map((entry) =>
      entry.id === 'nord' ? { id: 'nord', label: 'Nord Polar', group: 'Arctic' } : entry));
  });

  it('removes the first entry and the last entry', () => {
    const ids = readRegistry(registryText).map((entry) => entry.id);
    expect(readRegistry(removeRegistryEntry(registryText, ids[0])).map((entry) => entry.id)).toEqual(ids.slice(1));
    expect(readRegistry(removeRegistryEntry(registryText, ids.at(-1))).map((entry) => entry.id))
      .toEqual(ids.slice(0, -1));
  });
});

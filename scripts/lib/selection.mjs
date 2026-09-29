/**
 * The authored selection grammar: one `font:U+XXXX` string per pooled glyph.
 *
 * Kept free of Node and DOM imports so the build, the dev-server plugin, and the
 * browser page all parse a selection with one implementation. A disagreement
 * between the writer and the reader would otherwise surface as a build failure
 * after a save that reported success.
 */

const ENTRY_PATTERN = /^([a-z0-9][a-z0-9-]*):[uU]\+([0-9a-fA-F]{1,6})$/;
const DOUBLE_HYPHEN = '--';
const MAX_CODE_POINT = 0x10ffff;
const HEX_DIGITS = 4;

export function formatEntry(font, codePoint) {
  return `${font}:U+${codePoint.toString(16).toUpperCase().padStart(HEX_DIGITS, '0')}`;
}

/** The key a candidate is filed under, shared by the catalog and the selection. */
export function candidateKey(font, codePoint) {
  return formatEntry(font, codePoint);
}

export function parseEntry(entry) {
  if (typeof entry !== 'string') {
    throw new Error(`A selection entry must be a string, got ${typeof entry}.`);
  }
  const groups = ENTRY_PATTERN.exec(entry.trim());
  if (!groups) {
    throw new Error(
      `Cannot read "${entry}" as a selection entry. `
      + 'Expected "<font-slug>:U+XXXX", for example "libertinus-math:U+2665".'
    );
  }
  const [, font, hex] = groups;
  if (font.includes(DOUBLE_HYPHEN)) {
    throw new Error(
      `The font slug in "${entry}" contains "${DOUBLE_HYPHEN}", which separates a font from a glyph in a symbol id.`
    );
  }
  const codepoint = Number.parseInt(hex, 16);
  if (codepoint > MAX_CODE_POINT) {
    throw new Error(`The codepoint in "${entry}" is outside the Unicode range.`);
  }
  return { font, codepoint };
}

export function parseSelection(selection) {
  if (!Array.isArray(selection)) {
    throw new Error('A selection must be a list of "<font-slug>:U+XXXX" strings.');
  }
  return selection.map(parseEntry);
}

export function sortEntries(entries) {
  return [...entries]
    .map(parseEntry)
    .sort((a, b) => a.font.localeCompare(b.font) || a.codepoint - b.codepoint)
    .map(({ font, codepoint }) => formatEntry(font, codepoint));
}

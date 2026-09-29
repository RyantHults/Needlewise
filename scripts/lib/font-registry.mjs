import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCandidates, loadFont } from './symbol-font.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const FONTS_DIR = resolve(REPO_ROOT, 'fonts');

/** The file extensions the pool loads, and the one definition of "a font file". */
export const FONT_EXTENSIONS = ['.ttf', '.otf'];
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
/** A slug for a font that names neither itself nor its file. */
const FALLBACK_SLUG = 'font';

/** Whether a filename names a font the pool can draw from, whatever its case. */
export function isFontFileName(name) {
  return FONT_EXTENSIONS.includes(extname(name).toLowerCase());
}

/** The family name as the font's author wrote it, or the filename if it has none. */
function familyOf(font, fileName) {
  const names = font.names ?? {};
  return names.windows?.fontFamily?.en
    ?? names.macintosh?.fontFamily?.en
    ?? basename(fileName, extname(fileName));
}

function metaOf(font, key) {
  const names = font.names ?? {};
  return names.windows?.[key]?.en ?? names.macintosh?.[key]?.en ?? '';
}

/**
 * A URL- and CSS-safe identifier for a font file.
 *
 * The family name is the slug, so renaming a file does not change the ids
 * already built from it. Repeated separators collapse, so a slug never contains
 * the `--` that separates a font from a glyph inside a symbol id. A slug that is
 * already taken gets a numeric suffix, so two files reporting the same family
 * name stay addressable.
 *
 * A font with no usable name in either place is still a font the pool has to
 * address, so the slug is never empty: a selection entry is
 * `<slug>:<codepoint>` and its grammar requires a leading alphanumeric.
 */
export function slugForFamily(family, fileName, taken) {
  const slugify = (text) => text.toLowerCase().replace(NON_ALPHANUMERIC, '-').replace(EDGE_HYPHENS, '');
  const stem = basename(fileName, extname(fileName));
  const base = slugify(family ?? '') || slugify(stem) || FALLBACK_SLUG;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Where the file lives, as a repo-relative forward-slashed path.
 *
 * A font from outside the repository records its absolute path, because a
 * relative path out of the repo means nothing to whoever reads the artifact.
 */
function repoRelative(absPath) {
  const relativePath = relative(REPO_ROOT, absPath).split(sep).join('/');
  return relativePath.startsWith('..') ? absPath : relativePath;
}

/**
 * Every font the pool can draw from, in a stable order.
 *
 * A file that is not a font is an error rather than a skip: a mistyped drop-in
 * would otherwise leave the pool quietly missing every glyph that font was meant
 * to contribute, with nothing to show that it happened.
 */
export function discoverFonts(dir = FONTS_DIR) {
  let files;
  try {
    files = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const fontFiles = files
    .filter(isFontFileName)
    .filter((name) => statSync(resolve(dir, name)).isFile())
    .sort();

  const taken = new Set();
  return fontFiles.map((name) => {
    const absPath = resolve(dir, name);
    let font;
    try {
      font = loadFont(absPath);
    } catch {
      throw new Error(`${name} is not a font file that could be read.`);
    }
    const family = familyOf(font, name);
    const slug = slugForFamily(family, name, taken);
    taken.add(slug);
    return {
      slug,
      family,
      file: repoRelative(absPath),
      absPath,
      sha256: sha256Of(readFileSync(absPath)),
      unitsPerEm: font.unitsPerEm,
      version: metaOf(font, 'version'),
      licenseUrl: metaOf(font, 'licenseURL'),
      drawableCodepoints: listCandidates(font, slug).length
    };
  });
}

/**
 * The recorded form of a font.
 *
 * `file` is the repo-relative path when the font is vendored in this repository
 * and an absolute one when it is not, so it is carried through unchanged; only
 * the `absPath` the registry was read from is dropped.
 */
export function toProvenance(record) {
  return {
    family: record.family,
    file: record.file,
    sha256: record.sha256,
    unitsPerEm: record.unitsPerEm,
    version: record.version,
    licenseUrl: record.licenseUrl,
    drawableCodepoints: record.drawableCodepoints
  };
}

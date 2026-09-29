#!/usr/bin/env node
/**
 * Development-only middleware behind the symbol picker at /__symbols.
 *
 * The picker is a curation tool, not part of the application: it lets someone
 * browse every glyph the vendored fonts can draw and write the chosen subset
 * back to src/symbols/selection.json. It is mounted only in dev, so a
 * production bundle has no way to rewrite the pool even if the route were
 * reachable.
 *
 * Three responsibilities, all of which the browser deliberately cannot do:
 * listing the vendored fonts, serving their bytes, and owning the authored file
 * on disk.
 */

import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assignIds, listCandidates, loadFont } from './lib/symbol-font.mjs';
import { discoverFonts, FONTS_DIR } from './lib/font-registry.mjs';
import { sortEntries } from './lib/selection.mjs';
import { SELECTION_PATH, selectCandidates } from './build-symbol-outlines.mjs';

const PICKER_PREFIX = '/__symbols';
export const FONT_ROUTE_PREFIX = `${PICKER_PREFIX}/font`;
export const REGISTRY_ROUTE = `${PICKER_PREFIX}/fonts`;
export const SAVE_ROUTE = `${PICKER_PREFIX}/selection`;
const FONT_EXTENSION = '.ttf';
/** A selection naming every candidate of every font is a few hundred kilobytes. */
const MAX_BODY_BYTES = 1024 * 1024;

const sendJson = (response, status, payload) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
};

const readBody = (request) => new Promise((resolveBody, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('The selection sent was too large.'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

/**
 * What is in fonts/ right now, re-read only when the directory changes.
 *
 * Discovering a font means parsing it and walking every glyph it maps, which is
 * far too much to repeat on each of the picker's requests. A font dropped into
 * the directory is the point of the tool, so the cache is keyed on the files
 * themselves and a new one is picked up on the next request.
 */
let cachedSignature = null;
let cachedRegistry = null;

function fontsSignature(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 'absent';
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith(FONT_EXTENSION))
    .sort()
    .map((name) => {
      const stats = statSync(join(dir, name));
      return `${name}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');
}

function registryFor(dir = FONTS_DIR) {
  const signature = fontsSignature(dir);
  if (signature !== cachedSignature) {
    cachedRegistry = discoverFonts(dir);
    cachedSignature = signature;
  }
  return cachedRegistry;
}

/**
 * Write a new selection, validated with the build's own rule set.
 *
 * The browser sends only the list of entries. Font provenance is derived from
 * the files in fonts/, so there is nothing for the page to claim about them and
 * nothing here to keep in sync.
 */
function saveSelection(entries) {
  const selection = sortEntries(entries);
  const registry = registryFor();
  const candidates = assignIds(
    registry.flatMap((record) => listCandidates(loadFont(record.absPath), record.slug))
  );
  selectCandidates(candidates, selection);
  const next = { version: 3, selection };
  writeFileSync(SELECTION_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function serveFont(slug, response) {
  const record = registryFor().find((font) => font.slug === slug);
  if (!record) {
    sendJson(response, 404, { error: `No font with the slug "${slug}".` });
    return;
  }
  response.setHeader('Content-Type', 'font/ttf');
  response.setHeader('Cache-Control', 'no-store');
  createReadStream(record.absPath).pipe(response);
}

/** A Vite plugin that serves the fonts and saves selections during dev. */
export default function symbolPickerPlugin() {
  return {
    name: 'needlewise-symbol-picker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];

        if (path.startsWith(`${FONT_ROUTE_PREFIX}/`)) {
          const slug = path.slice(FONT_ROUTE_PREFIX.length + 1)
            .replace(new RegExp(`${FONT_EXTENSION}$`), '');
          serveFont(slug, response);
          return;
        }

        if (path === REGISTRY_ROUTE) {
          sendJson(response, 200, {
            fonts: registryFor().map((record) => ({
              slug: record.slug,
              family: record.family,
              url: `${FONT_ROUTE_PREFIX}/${record.slug}.ttf`
            }))
          });
          return;
        }

        if (path !== SAVE_ROUTE) return next();

        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          sendJson(response, 405, { error: 'Use POST to save a selection.' });
          return;
        }

        void (async () => {
          try {
            const body = JSON.parse(await readBody(request));
            if (!Array.isArray(body?.selection)) {
              sendJson(response, 400, {
                error: 'Expected a body of the form { "selection": ["libertinus-math:U+2665"] }.'
              });
              return;
            }
            if (body.selection.length === 0) {
              sendJson(response, 400, { error: 'A symbol pool needs at least one symbol.' });
              return;
            }
            const saved = saveSelection(body.selection);
            const perFont = {};
            for (const entry of saved.selection) {
              const font = entry.slice(0, entry.indexOf(':'));
              perFont[font] = (perFont[font] ?? 0) + 1;
            }
            sendJson(response, 200, {
              saved: saved.selection.length,
              perFont,
              file: 'src/symbols/selection.json',
              next: 'pnpm symbols:build'
            });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
        })();
      });
    }
  };
}

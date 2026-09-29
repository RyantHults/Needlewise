#!/usr/bin/env node
/**
 * Development-only middleware behind the symbol picker at /__symbols.
 *
 * The picker is a curation tool, not part of the application: it lets someone
 * browse every glyph the font can draw and write the chosen subset back to
 * src/symbols/selection.json. It is mounted only in dev, so a production bundle
 * has no way to rewrite the pool even if the route were reachable.
 *
 * Two responsibilities, both of which the browser deliberately cannot do:
 * serving the font bytes, and owning the authored file on disk.
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCandidates, loadFont } from './lib/symbol-font.mjs';
import { SELECTION_PATH, readSelection, selectCandidates } from './build-symbol-outlines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_PATH = resolve(HERE, '../fonts/LibertinusMath-Regular.ttf');
const PICKER_PREFIX = '/__symbols';
const FONT_ROUTE = `${PICKER_PREFIX}/LibertinusMath-Regular.ttf`;
const SAVE_ROUTE = `${PICKER_PREFIX}/selection`;
const MAX_BODY_BYTES = 256 * 1024;

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
};

const readBody = (request) => new Promise((resolveBody, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    // A selection of every codepoint is a few tens of kilobytes. Anything much
    // larger is a mistake, and buffering it unbounded is how a dev server dies.
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
 * Write a new selection, keeping the recorded font provenance.
 *
 * The browser is only allowed to send the list of codepoints. The digest and
 * license stay where they are, because they describe the vendored file on this
 * machine rather than anything the page could know.
 */
function saveSelection(selection) {
  const existing = readSelection();
  const next = {
    ...existing,
    font: existing.font,
    selection: [...selection].sort()
  };
  // Validate with the build's own rule set, so the picker cannot write a
  // selection the build would then reject.
  selectCandidates(listCandidates(loadFont()), next.selection);
  writeFileSync(SELECTION_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** A Vite plugin that serves the font and saves selections during dev. */
export default function symbolPickerPlugin() {
  return {
    name: 'needlewise-symbol-picker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];
        if (path !== FONT_ROUTE && path !== SAVE_ROUTE) return next();

        if (path === FONT_ROUTE) {
          response.setHeader('Content-Type', 'font/ttf');
          response.setHeader('Cache-Control', 'no-store');
          createReadStream(FONT_PATH).pipe(response);
          return;
        }

        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          sendJson(response, 405, { error: 'Use POST to save a selection.' });
          return;
        }

        void (async () => {
          try {
            const body = JSON.parse(await readBody(request));
            if (!Array.isArray(body?.selection)) {
              sendJson(response, 400, { error: 'Expected a body of the form { "selection": ["U+2665"] }.' });
              return;
            }
            if (body.selection.length === 0) {
              sendJson(response, 400, { error: 'A symbol pool needs at least one symbol.' });
              return;
            }
            const saved = saveSelection(body.selection);
            sendJson(response, 200, {
              saved: saved.selection.length,
              file: 'src/symbols/selection.json',
              next: 'node scripts/build-symbol-outlines.mjs'
            });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
        })();
      });
    }
  };
}

export { FONT_ROUTE, SAVE_ROUTE };

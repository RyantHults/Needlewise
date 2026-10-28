#!/usr/bin/env node
/**
 * Development-only middleware behind the theme editor overlay.
 *
 * The editor is a dev tool, not part of the application: it lists the themes
 * in src/themes/ and writes edits, copies and deletions back to those files
 * and to the THEME_OPTIONS registry. It is mounted only in dev, so a
 * production bundle has no way to rewrite a theme even if the routes were
 * reachable. Vite's watcher picks up every write: CSS edits hot-swap and a
 * registry change reloads the page.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addRegistryEntry,
  applyThemeEdits,
  duplicateTheme,
  readRegistry,
  readTheme,
  removeRegistryEntry,
  updateRegistryEntry
} from './lib/theme-files.mjs';

const ROUTE_PREFIX = '/__themes';
export const THEMES_ROUTE = `${ROUTE_PREFIX}/themes`;
export const SAVE_ROUTE = `${ROUTE_PREFIX}/save`;
export const CREATE_ROUTE = `${ROUTE_PREFIX}/create`;
export const DELETE_ROUTE = `${ROUTE_PREFIX}/delete`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = resolve(REPO_ROOT, 'src/themes');
const REGISTRY_PATH = resolve(REPO_ROOT, 'src/components/app-theme.ts');

/** The theme every other one redefines: editable, but never copied or deleted. */
const DEFAULT_THEME_ID = 'needlewise';
/** A registry choice that resolves to another theme and has no file. */
const SYSTEM_THEME_ID = 'system';
const THEME_ID_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Every value of the largest theme is a few kilobytes. */
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
      reject(new Error('The request body was too large.'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireText(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Expected "${field}" to be a non-empty string.`);
  }
  return value;
}

/** A registry entry the editor can open, which is any but "system". */
function requireTheme(registry, id) {
  const entry = registry.find((option) => option.id === id);
  if (!entry || id === SYSTEM_THEME_ID) throw new Error(`There is no theme "${id}".`);
  return entry;
}

function listedTheme(entry, themesDir) {
  const path = join(themesDir, `${entry.id}.css`);
  const copyable = entry.id !== DEFAULT_THEME_ID;
  return {
    ...entry,
    file: relative(process.cwd(), path),
    editable: { duplicate: copyable, delete: copyable },
    ...readTheme(readFileSync(path, 'utf8'))
  };
}

function listThemes(themesDir, registryPath) {
  return readRegistry(readFileSync(registryPath, 'utf8'))
    .filter((entry) => entry.id !== SYSTEM_THEME_ID)
    .map((entry) => listedTheme(entry, themesDir));
}

/** Write the edited values, and the registry entry when its label or group changed. */
function saveTheme(body, themesDir, registryPath) {
  const id = requireText(body, 'id');
  const label = requireText(body, 'label');
  const group = requireText(body, 'group');
  if (!isRecord(body.values)) throw new Error('Expected "values" to map custom properties to values.');
  if (body.colorScheme === undefined) throw new Error('Expected "colorScheme" to be "light", "dark" or null.');
  const registryText = readFileSync(registryPath, 'utf8');
  const entry = requireTheme(readRegistry(registryText), id);
  const path = join(themesDir, `${id}.css`);
  const cssText = readFileSync(path, 'utf8');
  const edited = applyThemeEdits(cssText, { colorScheme: body.colorScheme, values: body.values });
  if (edited !== cssText) writeFileSync(path, edited);
  if (entry.label !== label || entry.group !== group) {
    writeFileSync(registryPath, updateRegistryEntry(registryText, id, { label, group }));
  }
  return listedTheme({ id, label, group }, themesDir);
}

/** Copy a theme to a new file and register it. */
function createTheme(body, themesDir, registryPath) {
  const from = requireText(body, 'from');
  const id = requireText(body, 'id');
  const label = requireText(body, 'label');
  const group = requireText(body, 'group');
  if (!THEME_ID_FORMAT.test(id)) {
    throw new Error(`A theme id is lowercase words joined by hyphens, such as "nord-frost", not "${id}".`);
  }
  const registryText = readFileSync(registryPath, 'utf8');
  const registry = readRegistry(registryText);
  requireTheme(registry, from);
  if (from === DEFAULT_THEME_ID) throw new Error(`The default theme "${DEFAULT_THEME_ID}" cannot be copied.`);
  const path = join(themesDir, `${id}.css`);
  if (registry.some((entry) => entry.id === id) || existsSync(path)) {
    throw new Error(`A theme "${id}" already exists.`);
  }
  const copied = duplicateTheme(readFileSync(join(themesDir, `${from}.css`), 'utf8'), { id, label });
  // The file goes first, so the reload the registry write causes finds it.
  writeFileSync(path, copied);
  writeFileSync(registryPath, addRegistryEntry(registryText, { id, label, group }));
  return { id };
}

/** Unregister a theme and delete its file. */
function deleteTheme(body, themesDir, registryPath) {
  const id = requireText(body, 'id');
  const registryText = readFileSync(registryPath, 'utf8');
  requireTheme(readRegistry(registryText), id);
  if (id === DEFAULT_THEME_ID) throw new Error(`The default theme "${DEFAULT_THEME_ID}" cannot be deleted.`);
  writeFileSync(registryPath, removeRegistryEntry(registryText, id));
  unlinkSync(join(themesDir, `${id}.css`));
  return { id };
}

const POST_ROUTES = new Map([
  [SAVE_ROUTE, saveTheme],
  [CREATE_ROUTE, createTheme],
  [DELETE_ROUTE, deleteTheme]
]);

/**
 * A Vite plugin that lists and writes the themes during dev.
 *
 * `themesDir` and `registryPath` default to src/themes/ and the THEME_OPTIONS
 * registry; both are parameters so a test can exercise the whole request path
 * against copies of its own.
 */
export default function themeEditorPlugin({
  themesDir = THEMES_DIR,
  registryPath = REGISTRY_PATH
} = {}) {
  return {
    name: 'needlewise-theme-editor',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];

        if (path === THEMES_ROUTE) {
          if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            sendJson(response, 405, { error: 'Use GET to list the themes.' });
            return;
          }
          try {
            sendJson(response, 200, { themes: listThemes(themesDir, registryPath) });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
          return;
        }

        const handle = POST_ROUTES.get(path);
        if (!handle) return next();

        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          sendJson(response, 405, { error: `Use POST for ${path}.` });
          return;
        }

        void (async () => {
          try {
            const body = JSON.parse(await readBody(request));
            if (!isRecord(body)) throw new Error('Expected a JSON object body.');
            sendJson(response, 200, handle(body, themesDir, registryPath));
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
        })();
      });
    }
  };
}

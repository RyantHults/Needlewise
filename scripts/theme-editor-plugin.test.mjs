import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import themeEditorPlugin, { CREATE_ROUTE, DELETE_ROUTE, SAVE_ROUTE, THEMES_ROUTE } from './theme-editor-plugin.mjs';

/** Copies of the themes and the registry, so no request reaches the authored files. */
function scratchCopies() {
  const dir = mkdtempSync(join(tmpdir(), 'theme-editor-'));
  const themesDir = join(dir, 'themes');
  const registryPath = join(dir, 'app-theme.ts');
  cpSync('src/themes', themesDir, { recursive: true });
  writeFileSync(registryPath, readFileSync('src/components/app-theme.ts'));
  return { themesDir, registryPath };
}

function makeServer(options) {
  const handlers = [];
  themeEditorPlugin(options).configureServer({ middlewares: { use: (fn) => handlers.push(fn) } });
  return {
    handle(method, url, body) {
      const request = Object.assign(new EventEmitter(), { method, url, destroy() {} });
      const headers = {};
      return new Promise((done) => {
        const response = {
          statusCode: 200,
          setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
          end: (text) => done({ status: response.statusCode, headers, body: JSON.parse(text) })
        };
        handlers[0](request, response, () => done({ status: 'next' }));
        if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
        request.emit('end');
      });
    }
  };
}

const tokenValue = (theme, name) =>
  theme.groups.flatMap((group) => group.tokens).find((token) => token.name === name)?.value;

describe('themeEditorPlugin', () => {
  it('lists every theme but "system", in registry order', async () => {
    const server = makeServer(scratchCopies());
    const { status, body } = await server.handle('GET', THEMES_ROUTE);
    expect(status).toBe(200);
    expect(body.themes[0]).toMatchObject({
      id: 'needlewise',
      colorScheme: null,
      editable: { duplicate: false, delete: false }
    });
    expect(body.themes.map((theme) => theme.id)).not.toContain('system');
    expect(body.themes.find((theme) => theme.id === 'nord')).toMatchObject({
      label: 'Nord',
      group: 'Nord',
      colorScheme: 'dark',
      editable: { duplicate: true, delete: true }
    });
  });

  it('creates, saves and deletes a theme', async () => {
    const copies = scratchCopies();
    const server = makeServer(copies);
    const nordBefore = readFileSync(join(copies.themesDir, 'nord.css'), 'utf8');

    expect((await server.handle('POST', CREATE_ROUTE, {
      from: 'nord', id: 'nord-frost', label: 'Nord Frost', group: 'Nord'
    })).body).toEqual({ id: 'nord-frost' });

    const saved = await server.handle('POST', SAVE_ROUTE, {
      id: 'nord-frost',
      label: 'Frost',
      group: 'Arctic',
      colorScheme: 'light',
      values: { '--color-page': '#eceff4' }
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ id: 'nord-frost', label: 'Frost', group: 'Arctic', colorScheme: 'light' });
    expect(tokenValue(saved.body, '--color-page')).toBe('#eceff4');

    const listed = (await server.handle('GET', THEMES_ROUTE)).body.themes;
    expect(listed.find((theme) => theme.id === 'nord-frost')).toEqual(saved.body);
    expect(readFileSync(join(copies.themesDir, 'nord.css'), 'utf8')).toBe(nordBefore);

    expect((await server.handle('POST', DELETE_ROUTE, { id: 'nord-frost' })).body).toEqual({ id: 'nord-frost' });
    expect(existsSync(join(copies.themesDir, 'nord-frost.css'))).toBe(false);
    expect(readFileSync(copies.registryPath, 'utf8')).toBe(readFileSync('src/components/app-theme.ts', 'utf8'));
  });

  it('refuses to copy or delete the default theme, or to reuse an id', async () => {
    const server = makeServer(scratchCopies());
    const refusals = await Promise.all([
      server.handle('POST', CREATE_ROUTE, { from: 'needlewise', id: 'paper', label: 'Paper', group: 'Paper' }),
      server.handle('POST', CREATE_ROUTE, { from: 'nord', id: 'dracula', label: 'Copy', group: 'Nord' }),
      server.handle('POST', CREATE_ROUTE, { from: 'nord', id: 'Nord Copy', label: 'Copy', group: 'Nord' }),
      server.handle('POST', DELETE_ROUTE, { id: 'needlewise' }),
      server.handle('POST', DELETE_ROUTE, { id: 'system' })
    ]);
    for (const refusal of refusals) {
      expect(refusal.status).toBe(400);
      expect(typeof refusal.body.error).toBe('string');
    }
  });

  it('answers the wrong method with 405 and the allowed one', async () => {
    const server = makeServer(scratchCopies());
    const listed = await server.handle('POST', THEMES_ROUTE, {});
    expect(listed.status).toBe(405);
    expect(listed.headers.allow).toBe('GET');
    const saved = await server.handle('GET', SAVE_ROUTE);
    expect(saved.status).toBe(405);
    expect(saved.headers.allow).toBe('POST');
  });
});

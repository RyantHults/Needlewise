import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import symbolPickerPlugin, {
  FONT_ROUTE_PREFIX,
  REGISTRY_ROUTE,
  SAVE_ROUTE,
  fontsSignature
} from './symbol-picker-plugin.mjs';
import { discoverFonts, FONTS_DIR } from './lib/font-registry.mjs';
import { ARTIFACT_VERSION } from './build-symbol-outlines.mjs';

/** Every font parse, wherever it was asked for, so caching can be measured. */
const parses = vi.hoisted(() => ({ fonts: 0 }));

vi.mock('./lib/symbol-font.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadFont(path) {
      parses.fonts += 1;
      return actual.loadFont(path);
    }
  };
});

const AUTHORED_SELECTION = 'src/symbols/selection.json';
const authoredSelectionBefore = readFileSync(AUTHORED_SELECTION, 'utf8');
const registry = discoverFonts(FONTS_DIR);

/** A stand-in for an HTTP response that a readable stream can pipe into. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers = {};
  body = '';
  chunks = [];

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.body = Buffer.concat(this.chunks).toString('utf8');
    this.emit('finish');
  }
}

function makeServer() {
  const handlers = [];
  return {
    middlewares: { use: (fn) => handlers.push(fn) },
    handle(method, url, body) {
      const request = Object.assign(new EventEmitter(), { method, url, destroy() {} });
      const response = new FakeResponse();
      // A JSON reply is written synchronously inside the handler, while a
      // served font is piped in over several ticks. Waiting for the response to
      // finish covers both without reading a half-written font.
      let settle;
      const finished = new Promise((done) => { settle = () => done(response); });
      response.once('finish', settle);
      handlers[0](request, response, () => {});
      if (body !== undefined) request.emit('data', Buffer.from(body));
      request.emit('end');
      return finished;
    }
  };
}

/** A save must never reach the authored file, so every one gets its own path. */
const scratchSelection = () => join(mkdtempSync(join(tmpdir(), 'picker-selection-')), 'selection.json');

const serve = async (method, url, body, options) => {
  const plugin = symbolPickerPlugin(options);
  const server = makeServer();
  plugin.configureServer(server);
  return server.handle(method, url, body);
};

afterAll(() => {
  expect(readFileSync(AUTHORED_SELECTION, 'utf8')).toBe(authoredSelectionBefore);
});

describe('the font cache key', () => {
  it('changes when a font appears in either extension', () => {
    // The cached registry is only as fresh as this string. A font the predicate
    // below does not see is a font the picker will keep reporting as absent,
    // however many times it is asked.
    const dir = mkdtempSync(join(tmpdir(), 'picker-signature-'));
    copyFileSync(join(FONTS_DIR, 'LibertinusMath-Regular.ttf'), join(dir, 'LibertinusMath-Regular.ttf'));
    const withTtfOnly = fontsSignature(dir);
    copyFileSync(join(FONTS_DIR, 'NotoSansSymbols2-Regular.ttf'), join(dir, 'NotoSansSymbols2-Regular.otf'));
    expect(fontsSignature(dir)).not.toBe(withTtfOnly);
  });

  it('ignores a file the font registry would not load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picker-signature-'));
    const empty = fontsSignature(dir);
    writeFileSync(join(dir, 'OFL.txt'), 'license text');
    expect(fontsSignature(dir)).toBe(empty);
  });

  it('is a single stable string for an unchanged directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picker-signature-'));
    copyFileSync(join(FONTS_DIR, 'NotoSansSymbols2-Regular.ttf'), join(dir, 'NotoSansSymbols2-Regular.ttf'));
    expect(fontsSignature(dir)).toBe(fontsSignature(dir));
  });
});

describe('the picker plugin', () => {
  it('names a font route and a registry route', () => {
    expect(FONT_ROUTE_PREFIX).toBe('/__symbols/font');
    expect(SAVE_ROUTE).toBe('/__symbols/selection');
    expect(REGISTRY_ROUTE).toBe('/__symbols/fonts');
  });

  it('serves every discovered font at its slug', async () => {
    for (const record of registry) {
      const response = await serve('GET', `${FONT_ROUTE_PREFIX}/${record.slug}.ttf`);
      expect(response.statusCode, record.slug).toBe(200);
    }
  });

  it('serves the exact bytes the recorded digest was taken from', async () => {
    for (const record of registry) {
      const response = await serve('GET', `${FONT_ROUTE_PREFIX}/${record.slug}.ttf`);
      const digest = createHash('sha256')
        .update(Buffer.concat(response.chunks))
        .digest('hex');
      expect(digest, record.slug).toBe(record.sha256);
    }
  });

  it('declares a font content type', async () => {
    const response = await serve('GET', `${FONT_ROUTE_PREFIX}/${registry[0].slug}.ttf`);
    expect(response.headers['content-type']).toContain('font');
  });

  it('404s a font slug that is not vendored', async () => {
    const response = await serve('GET', `${FONT_ROUTE_PREFIX}/no-such-font.ttf`);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/no-such-font/);
  });

  it('lists every font with the url it is served at', async () => {
    const response = await serve('GET', REGISTRY_ROUTE);
    expect(response.statusCode).toBe(200);
    const { fonts } = JSON.parse(response.body);
    expect(fonts.map((f) => f.slug).sort()).toEqual(registry.map((r) => r.slug).sort());
    for (const font of fonts) {
      expect(font.family.length).toBeGreaterThan(0);
      expect(font.url).toBe(`${FONT_ROUTE_PREFIX}/${font.slug}.ttf`);
    }
  });

  it('passes an unrelated path through to the next middleware', async () => {
    const plugin = symbolPickerPlugin();
    const handlers = [];
    const server = { middlewares: { use: (fn) => handlers.push(fn) } };
    plugin.configureServer(server);
    const request = Object.assign(new EventEmitter(), { method: 'GET', url: '/index.html' });
    let calledNext = false;
    handlers[0](request, new FakeResponse(), () => { calledNext = true; });
    expect(calledNext).toBe(true);
  });

  it('rejects a save naming a font that does not exist', async () => {
    const response = await serve(
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['no-such-font:U+2665'] }),
      { selectionPath: scratchSelection() }
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/no-such-font/);
  });

  it('rejects a save whose codepoint the named font cannot draw', async () => {
    const response = await serve(
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['noto-sans-symbols-2:U+10FFFD'] }),
      { selectionPath: scratchSelection() }
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/U\+10FFFD/);
  });

  it('saves an empty selection, because curation starts from an empty pool', async () => {
    // A pool is curated by choosing glyphs, so clearing every one of them has to
    // be expressible. Refusing it would leave the picker unable to return to the
    // state it was opened in.
    const selectionPath = scratchSelection();
    const response = await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: [] }), { selectionPath });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      saved: 0,
      perFont: {},
      file: AUTHORED_SELECTION,
      next: 'pnpm symbols:build'
    });
    expect(readFileSync(selectionPath, 'utf8')).toBe(`${JSON.stringify({ version: ARTIFACT_VERSION, selection: [] }, null, 2)}\n`);
  });

  it('rejects a save that is not a list of entries', async () => {
    const response = await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: 'libertinus-math:U+2665' }), { selectionPath: scratchSelection() });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/libertinus-math:U\+2665/);
  });

  it('answers GET on the save route with 405', async () => {
    const response = await serve('GET', SAVE_ROUTE);
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  it('leaves the authored file untouched when a save is rejected', async () => {
    await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: ['no-such-font:U+2665'] }), { selectionPath: scratchSelection() });
    expect(readFileSync(AUTHORED_SELECTION, 'utf8')).toBe(authoredSelectionBefore);
  });

  it('writes the sorted selection and reports what it saved per font', async () => {
    const selectionPath = scratchSelection();
    const response = await serve('POST', SAVE_ROUTE, JSON.stringify({
      selection: ['noto-sans-symbols-2:U+2666', 'libertinus-math:U+2665', 'libertinus-math:U+2660']
    }), { selectionPath });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      saved: 3,
      perFont: { 'libertinus-math': 2, 'noto-sans-symbols-2': 1 },
      file: AUTHORED_SELECTION,
      next: 'pnpm symbols:build'
    });
    expect(readFileSync(selectionPath, 'utf8')).toBe(`${JSON.stringify({
      version: ARTIFACT_VERSION,
      selection: ['libertinus-math:U+2660', 'libertinus-math:U+2665', 'noto-sans-symbols-2:U+2666']
    }, null, 2)}\n`);
  });

  it('writes nothing when validation fails', async () => {
    const selectionPath = scratchSelection();
    const response = await serve(
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['libertinus-math:U+2665', 'no-such-font:U+2665'] }),
      { selectionPath }
    );
    expect(response.statusCode).toBe(400);
    expect(existsSync(selectionPath)).toBe(false);
  });

  it('notices a font dropped into the directory, whatever extension it has', async () => {
    // A drop-in is not restricted to one extension, and the picker has to agree
    // with the build about which files are fonts: a font the build can read but
    // the picker cannot see would fail a save that named it. The directory is
    // already cached here, so a new file that the cache does not look at stays
    // invisible however many times the picker is asked.
    const fontsDir = mkdtempSync(join(tmpdir(), 'picker-fonts-'));
    copyFileSync(join(FONTS_DIR, 'LibertinusMath-Regular.ttf'), join(fontsDir, 'LibertinusMath-Regular.ttf'));
    const options = { fontsDir, selectionPath: scratchSelection() };
    const slugsOf = (body) => JSON.parse(body).fonts.map((font) => font.slug).sort();

    const before = await serve('GET', REGISTRY_ROUTE, undefined, options);
    expect(slugsOf(before.body)).toEqual(['libertinus-math']);

    const otf = join(fontsDir, 'NotoSansSymbols2-Regular.otf');
    copyFileSync(join(FONTS_DIR, 'NotoSansSymbols2-Regular.ttf'), otf);
    const after = await serve('GET', REGISTRY_ROUTE, undefined, options);
    expect(slugsOf(after.body)).toEqual(['libertinus-math', 'noto-sans-symbols-2']);

    // The url a font is served at is the same shape for every font, so the
    // picker's stylesheet does not depend on the file name.
    expect(JSON.parse(after.body).fonts.every((font) => font.url === `${FONT_ROUTE_PREFIX}/${font.slug}.ttf`))
      .toBe(true);
    for (const suffix of ['.ttf', '.otf']) {
      const served = await serve('GET', `${FONT_ROUTE_PREFIX}/noto-sans-symbols-2${suffix}`, undefined, options);
      expect(served.statusCode, suffix).toBe(200);
      expect(createHash('sha256').update(Buffer.concat(served.chunks)).digest('hex'), suffix)
        .toBe(createHash('sha256').update(readFileSync(otf)).digest('hex'));
    }

    const saved = await serve(
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['noto-sans-symbols-2:U+2666'] }), options
    );
    expect(JSON.parse(saved.body)).toMatchObject({ saved: 1, perFont: { 'noto-sans-symbols-2': 1 } });
  });

  it('parses a font once, however many selections are saved', async () => {
    // Parsing is the whole cost the cache exists to avoid, and a save is the one
    // request that has to have the candidates in hand.
    const options = { selectionPath: scratchSelection() };
    const save = () => serve('POST', SAVE_ROUTE, JSON.stringify({ selection: ['libertinus-math:U+2665'] }), options);
    await serve('GET', REGISTRY_ROUTE, undefined, options);
    expect((await save()).statusCode).toBe(200);
    parses.fonts = 0;
    expect((await save()).statusCode).toBe(200);
    expect((await save()).statusCode).toBe(200);
    expect(parses.fonts).toBe(0);
  });
});

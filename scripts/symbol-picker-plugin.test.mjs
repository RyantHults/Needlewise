import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import symbolPickerPlugin, {
  FONT_ROUTE_PREFIX,
  REGISTRY_ROUTE,
  SAVE_ROUTE
} from './symbol-picker-plugin.mjs';
import { discoverFonts, FONTS_DIR } from './lib/font-registry.mjs';

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

const serve = async (method, url, body) => {
  const plugin = symbolPickerPlugin();
  const server = makeServer();
  plugin.configureServer(server);
  return server.handle(method, url, body);
};

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
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['no-such-font:U+2665'] })
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/no-such-font/);
  });

  it('rejects a save whose codepoint the named font cannot draw', async () => {
    const response = await serve(
      'POST', SAVE_ROUTE, JSON.stringify({ selection: ['noto-sans-symbols-2:U+10FFFD'] })
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/U\+10FFFD/);
  });

  it('rejects a save with no selection', async () => {
    const response = await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: [] }));
    expect(response.statusCode).toBe(400);
  });

  it('rejects a save that is not a list of entries', async () => {
    const response = await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: 'libertinus-math:U+2665' }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/libertinus-math:U\+2665/);
  });

  it('answers GET on the save route with 405', async () => {
    const response = await serve('GET', SAVE_ROUTE);
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  it('leaves the authored file untouched when a save is rejected', async () => {
    const before = readFileSync('src/symbols/selection.json', 'utf8');
    await serve('POST', SAVE_ROUTE, JSON.stringify({ selection: ['no-such-font:U+2665'] }));
    expect(readFileSync('src/symbols/selection.json', 'utf8')).toBe(before);
  });
});

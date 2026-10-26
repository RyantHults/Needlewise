import { describe, expect, it, vi } from 'vitest';
import { createPatternImportClient, type PatternImportFallback } from './import-client';
import type { WorkerLike } from '../workers/client';
import { PATTERN_IMPORT_PROTOCOL } from './import-protocol';
import { ImportError, type ImportAnalysis } from './types';

const analysis: ImportAnalysis = {
  format: 'fake', pages: [],
  chart: { width: 1, height: 1, cells: new Uint16Array(1), symbols: [], key: [], warnings: [] }
};

class FakeWorker implements WorkerLike {
  readonly posted: Record<string, unknown>[] = [];
  readonly terminate = vi.fn();
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  postMessage(message: unknown): void { this.posted.push(message as Record<string, unknown>); }
  addEventListener(type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener); }
  reply(message: Record<string, unknown>): void {
    for (const listener of this.listeners.message ?? []) listener({ data: { protocol: PATTERN_IMPORT_PROTOCOL, ...message } });
  }
  fail(message: string, type: 'error' | 'messageerror' = 'error'): void { for (const listener of this.listeners[type] ?? []) listener({ message }); }
}

function setup() {
  const worker = new FakeWorker();
  const client = createPatternImportClient({ workerFactory: () => worker });
  /** The id of the nth request the client posted. */
  const id = (n: number): unknown => worker.posted[n]?.requestId;
  return { worker, client, id };
}

const file = new Blob(['%PDF-']);

describe('pattern import client', () => {
  it('resolves an open with the worker result and reports progress', async () => {
    const { worker, client, id } = setup();
    const onProgress = vi.fn();
    const promise = client.open(file, 'a.pdf', { onProgress });
    expect(worker.posted[0]).toMatchObject({ type: 'open', fileName: 'a.pdf' });
    worker.reply({ type: 'progress', requestId: id(0), progress: { stage: 'reading', done: 1, total: 2 } });
    worker.reply({ type: 'result', requestId: id(0), analysis });
    await expect(promise).resolves.toBe(analysis);
    expect(onProgress).toHaveBeenCalledWith({ stage: 'reading', done: 1, total: 2 });
  });

  it('correlates concurrent requests by id and ignores strangers', async () => {
    const { worker, client, id } = setup();
    const first = client.open(file, 'a.pdf');
    const second = client.reanalyze({ pageRoles: { 0: 'key' } });
    worker.reply({ type: 'result', requestId: 'other', analysis });
    worker.reply({ type: 'result', requestId: id(1), analysis: { ...analysis, format: 'second' } });
    worker.reply({ type: 'result', requestId: id(0), analysis });
    await expect(second).resolves.toMatchObject({ format: 'second' });
    await expect(first).resolves.toBe(analysis);
  });

  it('rehydrates ImportError', async () => {
    const { worker, client, id } = setup();
    const promise = client.open(file, 'a.pdf');
    worker.reply({ type: 'error', requestId: id(0), error: { code: 'no-chart-found', message: 'none' } });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('no-chart-found');
  });

  it('sends cancel on abort and rejects as cancelled', async () => {
    const { worker, client, id } = setup();
    const controller = new AbortController();
    const promise = client.open(file, 'a.pdf', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', requestId: id(0) });
  });

  it('rejects immediately for an already aborted signal', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.open(file, 'a.pdf', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.posted).toHaveLength(0);
  });

  it('rejects pending requests when the worker errors', async () => {
    const { worker, client } = setup();
    const promise = client.open(file, 'a.pdf');
    worker.fail('crashed');
    await expect(promise).rejects.toThrow('crashed');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects pending requests when a worker message cannot be deserialized', async () => {
    const { worker, client } = setup();
    const promise = client.open(file, 'a.pdf');
    worker.fail('bad clone', 'messageerror');
    await expect(promise).rejects.toThrow('bad clone');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('dispose terminates the worker and cancels pending requests', async () => {
    const { worker, client } = setup();
    const promise = client.open(file, 'a.pdf');
    client.dispose();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalled();
    await expect(client.open(file, 'a.pdf')).rejects.toThrow(/disposed/);
  });

  describe('main-thread fallback', () => {
    function fallbackClient(fallback: PatternImportFallback) {
      return createPatternImportClient({ workerFactory: () => null, fallback: () => fallback });
    }

    it('runs open and reanalyze without a worker', async () => {
      const fallback: PatternImportFallback = {
        open: vi.fn(() => Promise.resolve(analysis)),
        reanalyze: vi.fn(() => Promise.resolve({ ...analysis, format: 'again' })),
        close: vi.fn(() => Promise.resolve())
      };
      const client = fallbackClient(fallback);
      await expect(client.open(file, 'a.pdf')).resolves.toBe(analysis);
      await expect(client.reanalyze({ pageRoles: { 0: 'key' } })).resolves.toMatchObject({ format: 'again' });
    });

    it('maps aborts and propagates errors', async () => {
      const controller = new AbortController();
      const fallback: PatternImportFallback = {
        open: vi.fn(() => new Promise<ImportAnalysis>(() => undefined)),
        reanalyze: vi.fn(() => Promise.reject(new ImportError('too-large', 'big'))),
        close: vi.fn(() => Promise.resolve())
      };
      const client = fallbackClient(fallback);
      const pending = client.open(file, 'a.pdf', { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await expect(client.reanalyze({})).rejects.toMatchObject({ code: 'too-large' });
    });

    it('sniffs 1024 bytes', async () => {
      vi.resetModules();
      const findImporter = vi.fn(() => ({
        open: () => Promise.resolve({ analyze: () => Promise.resolve(analysis), close: () => Promise.resolve() })
      }));
      vi.doMock('./registry', () => ({ findImporter }));
      const { createPatternImportClient: create } = await import('./import-client');
      const client = create({ workerFactory: () => null });
      const big = new Blob([new Uint8Array(2000)]);
      await client.open(big, 'a.pdf');
      expect((findImporter.mock.calls[0] as unknown as [Uint8Array])[0].length).toBe(1024);
      vi.doUnmock('./registry');
    });

    it('falls back through the registry by default, passing thumbnails through', async () => {
      const thumbnail = new Blob(['png'], { type: 'image/png' });
      const withThumbnail: ImportAnalysis = { ...analysis, pages: [{ index: 0, role: 'chart', detectedRole: 'chart', width: 1, height: 1, thumbnail }] };
      vi.resetModules();
      vi.doMock('./registry', () => ({
        findImporter: () => ({
          open: () => Promise.resolve({ analyze: () => Promise.resolve(withThumbnail), close: () => Promise.resolve() })
        })
      }));
      const { createPatternImportClient: create } = await import('./import-client');
      const client = create({ workerFactory: () => null });
      const result = await client.open(file, 'a.pdf');
      expect(result.pages[0]?.thumbnail).toBe(thumbnail);
      vi.doUnmock('./registry');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PATTERN_IMPORT_PROTOCOL, type PatternImportResponse } from '../import/import-protocol';
import { ImportError, type ImportAnalysis, type PatternImporter } from '../import/types';

const registry = vi.hoisted(() => ({ findImporter: vi.fn() }));
vi.mock('../import/registry', () => registry);

import { createPatternImportWorkerState, handlePatternImportWorkerMessage } from './pattern-import.worker';

const analysis = (cells = new Uint16Array(4)): ImportAnalysis => ({
  format: 'fake', pages: [],
  chart: { width: 2, height: 2, cells, symbols: [], key: [], warnings: [] }
});

const base = { protocol: PATTERN_IMPORT_PROTOCOL };
const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function harness() {
  const responses: PatternImportResponse[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  const state = createPatternImportWorkerState();
  const send = (message: unknown): void => {
    handlePatternImportWorkerMessage(message, (response, transfer) => { responses.push(response); transfers.push(transfer); }, state);
  };
  return { responses, transfers, state, send };
}

function fakeImporter(overrides: Partial<{ analyze: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = {}) {
  const close = overrides.close ?? vi.fn(() => Promise.resolve());
  const analyze = overrides.analyze ?? vi.fn((_o, options?: { onProgress?: (p: unknown) => void }) => {
    options?.onProgress?.({ stage: 'analyzing', done: 1, total: 1 });
    return Promise.resolve(analysis());
  });
  const open = vi.fn(() => Promise.resolve({ analyze, close }));
  const importer = { id: 'fake', label: 'Fake', accept: [], sniff: () => true, open } as unknown as PatternImporter;
  return { importer, open, analyze, close };
}

const openMessage = (requestId = 'a') => ({ ...base, type: 'open', requestId, file: new Blob(['%PDF-1']), fileName: 'x.pdf' });

describe('pattern import worker handler', () => {
  beforeEach(() => { registry.findImporter.mockReset(); });

  it('opens, reports progress and transfers the cell buffer', async () => {
    const { importer, open } = fakeImporter();
    registry.findImporter.mockReturnValue(importer);
    const { responses, transfers, send } = harness();
    send(openMessage());
    await wait();
    expect(open).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ fileName: 'x.pdf' }));
    expect(responses.map((r) => r.type)).toEqual(['progress', 'result']);
    const result = responses[1];
    if (result?.type !== 'result') throw new Error('expected result');
    expect(transfers[1]).toEqual([result.analysis.chart.cells.buffer]);
  });

  it('posts page thumbnails in the result without transferring them', async () => {
    const thumbnail = new Blob(['png'], { type: 'image/png' });
    const withThumbnail: ImportAnalysis = { ...analysis(), pages: [{ index: 0, role: 'chart', detectedRole: 'chart', width: 1, height: 1, thumbnail }] };
    const { importer } = fakeImporter({ analyze: vi.fn(() => Promise.resolve(withThumbnail)) });
    registry.findImporter.mockReturnValue(importer);
    const { responses, transfers, send } = harness();
    send(openMessage());
    await wait();
    const result = responses[0];
    if (result?.type !== 'result') throw new Error('expected result');
    expect(result.analysis.pages[0]?.thumbnail).toBe(thumbnail);
    expect(transfers[0]).toEqual([result.analysis.chart.cells.buffer]);
  });

  it('reanalyzes against the open session and rejects without one', async () => {
    const { importer, analyze } = fakeImporter();
    registry.findImporter.mockReturnValue(importer);
    const { responses, send } = harness();
    send({ ...base, type: 'reanalyze', requestId: 'r0', overrides: {} });
    await wait();
    expect(responses[0]).toMatchObject({ type: 'error', error: { code: 'unsupported-format' } });
    send(openMessage('a'));
    await wait();
    send({ ...base, type: 'reanalyze', requestId: 'r1', overrides: { pageRoles: { 0: 'key' } } });
    await wait();
    expect(analyze).toHaveBeenLastCalledWith({ pageRoles: { 0: 'key' } }, expect.any(Object));
    expect(responses.at(-1)).toMatchObject({ type: 'result', requestId: 'r1' });
  });

  it('sniffs the first 1024 bytes', async () => {
    registry.findImporter.mockReturnValue(undefined);
    const { send } = harness();
    send({ ...openMessage(), file: new Blob([new Uint8Array(2000)]) });
    await wait();
    expect((registry.findImporter.mock.calls[0]?.[0] as Uint8Array).length).toBe(1024);
  });

  it('serializes ImportError codes', async () => {
    const { importer, open } = fakeImporter();
    open.mockRejectedValue(new ImportError('encrypted-pdf', 'locked'));
    registry.findImporter.mockReturnValue(importer);
    const { responses, send } = harness();
    send(openMessage());
    await wait();
    expect(responses[0]).toEqual({ ...base, type: 'error', requestId: 'a', error: { code: 'encrypted-pdf', message: 'locked' } });
  });

  it('reports unsupported formats', async () => {
    registry.findImporter.mockReturnValue(undefined);
    const { responses, send } = harness();
    send(openMessage());
    await wait();
    expect(responses[0]).toMatchObject({ type: 'error', error: { code: 'unsupported-format' } });
  });

  it('cancels a running request through its abort signal', async () => {
    const analyze = vi.fn((_o, options?: { signal?: AbortSignal }) => new Promise<ImportAnalysis>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { reject(new DOMException('x', 'AbortError')); });
    }));
    const { importer } = fakeImporter({ analyze });
    registry.findImporter.mockReturnValue(importer);
    const { responses, state, send } = harness();
    send(openMessage());
    await wait();
    send({ ...base, type: 'cancel', requestId: 'a' });
    await wait();
    expect(responses).toEqual([{ ...base, type: 'cancelled', requestId: 'a' }]);
    expect(state.active.size).toBe(0);
  });

  it('ignores malformed messages and duplicate ids', async () => {
    const { importer } = fakeImporter({ analyze: vi.fn(() => new Promise<ImportAnalysis>(() => undefined)) });
    registry.findImporter.mockReturnValue(importer);
    const { responses, send } = harness();
    send({ nonsense: true });
    send(openMessage('a'));
    await wait();
    send(openMessage('a'));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ type: 'error', requestId: 'a' });
  });
});

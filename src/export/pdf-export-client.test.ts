import { describe, expect, it, vi } from 'vitest';
import { createDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { computePatternMetrics } from '../domain';
import { handlePdfExportWorkerMessage, type PdfExportWorkerDependencies } from '../workers/pdf-export.worker';
import type { WorkerLike } from '../workers/client';
import { DEFAULT_EXPORT_SETTINGS } from './export-settings';
import { PdfExportError, prepareWorkerInput, startPdfExport } from './pdf-export-client';
import { PDF_EXPORT_PROTOCOL, type PdfExportWorkerInput } from './pdf-export-protocol';

function input(): PdfExportWorkerInput {
  const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 4, height: 3 });
  document.kind[0] = 1;
  document.completed[0] = 1;
  return {
    document,
    metrics: computePatternMetrics(document),
    settings: DEFAULT_EXPORT_SETTINGS,
    units: 'metric',
    name: 'Test',
    coverImagePng: new Uint8Array([1, 2, 3])
  };
}

/** A worker double that runs the real message handler against injected dependencies. */
function fakeWorker(dependencies: PdfExportWorkerDependencies): WorkerLike & { terminated: boolean; sent: unknown[]; emitMessageError(): void } {
  const listeners: Array<(event: unknown) => void> = [];
  const messageErrorListeners: Array<(event: unknown) => void> = [];
  const active = new Map<string, AbortController>();
  const worker = {
    terminated: false,
    sent: [] as unknown[],
    postMessage(message: unknown) {
      worker.sent.push(message);
      handlePdfExportWorkerMessage(message, (response) => {
        queueMicrotask(() => { if (!worker.terminated) listeners.forEach((listener) => { listener({ data: response }); }); });
      }, active, dependencies);
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'message') listeners.push(listener);
      if (type === 'messageerror') messageErrorListeners.push(listener);
    },
    emitMessageError() { messageErrorListeners.forEach((listener) => { listener({}); }); },
    terminate() { worker.terminated = true; }
  };
  return worker;
}

describe('prepareWorkerInput', () => {
  it('copies arrays for transfer and never sends completion', () => {
    const source = input();
    const { input: prepared, transfer } = prepareWorkerInput(source);
    expect(prepared.document.kind).not.toBe(source.document.kind);
    expect(prepared.document.kind[0]).toBe(1);
    expect(source.document.kind.buffer.byteLength).toBeGreaterThan(0);
    expect(prepared.document.backstitches.completed.length).toBe(0);
    expect('completed' in prepared.document).toBe(false);
    expect(transfer).toContain(prepared.document.kind.buffer);
    expect(transfer).toContain(prepared.coverImagePng?.buffer);
  });
});

describe('startPdfExport', () => {
  const pdfBytes = new Uint8Array([37, 80, 68, 70]);

  it('relays progress and resolves with the PDF', async () => {
    const worker = fakeWorker({
      loadFont: () => Promise.resolve(new Uint8Array(1)),
      write: (_input, options) => { options.onProgress?.({ completed: 1, total: 2 }); return Promise.resolve(pdfBytes); }
    });
    const progress: number[] = [];
    const job = startPdfExport(input(), { workerFactory: () => worker, onProgress: (p) => progress.push(p.completed) });
    await expect(job.promise).resolves.toEqual(pdfBytes);
    expect(progress).toEqual([1]);
    expect(worker.terminated).toBe(true);
    expect(worker.sent[0]).toMatchObject({ protocol: PDF_EXPORT_PROTOCOL, type: 'export' });
  });

  it('cancels, terminating the worker', async () => {
    const worker = fakeWorker({
      loadFont: () => new Promise<Uint8Array>(() => undefined),
      write: () => Promise.resolve(pdfBytes)
    });
    const job = startPdfExport(input(), { workerFactory: () => worker });
    job.cancel();
    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'cancel', requestId: (worker.sent[0] as { requestId: string }).requestId });
  });

  it('cancels from an AbortSignal, including one already aborted', async () => {
    const controller = new AbortController();
    const worker = fakeWorker({ loadFont: () => new Promise<Uint8Array>(() => undefined), write: () => Promise.resolve(pdfBytes) });
    const job = startPdfExport(input(), { workerFactory: () => worker, signal: controller.signal });
    controller.abort();
    await expect(job.promise).rejects.toMatchObject({ name: 'AbortError' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(startPdfExport(input(), { workerFactory: () => fakeWorker({ loadFont: vi.fn(), write: vi.fn() }), signal: aborted.signal }).promise)
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports worker errors', async () => {
    const worker = fakeWorker({ loadFont: () => Promise.resolve(new Uint8Array(1)), write: () => Promise.reject(new Error('boom')) });
    await expect(startPdfExport(input(), { workerFactory: () => worker }).promise).rejects.toEqual(new PdfExportError('boom'));
  });

  it('rejects when a worker message cannot be deserialized', async () => {
    const worker = fakeWorker({ loadFont: () => new Promise<Uint8Array>(() => undefined), write: () => Promise.resolve(pdfBytes) });
    const job = startPdfExport(input(), { workerFactory: () => worker });
    worker.emitMessageError();
    await expect(job.promise).rejects.toBeInstanceOf(PdfExportError);
    expect(worker.terminated).toBe(true);
  });

  it('falls back to the calling thread without a worker', async () => {
    const fallback = vi.fn(() => Promise.resolve(pdfBytes));
    const job = startPdfExport(input(), { workerFactory: () => null, fallback });
    await expect(job.promise).resolves.toEqual(pdfBytes);
    expect(fallback).toHaveBeenCalledOnce();
  });
});

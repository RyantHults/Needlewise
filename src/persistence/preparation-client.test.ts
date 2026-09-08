import { describe, expect, it } from 'vitest';
import { applyCommand, cloneDocument, createDocument, type PatternDocument } from '../domain';
import { PersistenceError } from './errors';
import {
  createPreparationError,
  createPreparedMessage,
  prepareDocumentSnapshot,
  type PersistencePreparationResponse
} from './preparation';
import {
  PersistencePreparationStaleError,
  PersistencePreparationTransportError,
  PersistencePreparationWorkerClient
} from './preparation-client';

function document(): PatternDocument {
  const original = createDocument({ width: 2, height: 2, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  return applyCommand(original, { type: 'set-full', x: 1, y: 1, color: 1 }).document;
}

class FakeWorker {
  readonly posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  readonly transferredDocuments: PatternDocument[] = [];
  readonly terminated = { count: 0 };
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const request = message as { document?: PatternDocument };
    if (typeof structuredClone === 'function' && transfer !== undefined && request.document !== undefined) {
      const delivery = { ...request, document: cloneDocument(request.document) };
      this.transferredDocuments.push(request.document);
      // Exercise real detachment while keeping a same-realm message for the
      // fake worker's domain validation in jsdom.
      void structuredClone(message, { transfer });
      message = delivery;
    }
    this.posted.push({ message, transfer });
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(message: PersistencePreparationResponse): void {
    this.listeners.get('message')?.({ data: message });
  }

  emitTransport(type: 'error' | 'messageerror', event: unknown): void {
    this.listeners.get(type)?.(event);
  }

  terminate(): void {
    this.terminated.count += 1;
  }
}

async function preparedResponse(worker: FakeWorker): Promise<PersistencePreparationResponse> {
  const request = worker.posted[worker.posted.length - 1]?.message as { document: PatternDocument; token: Parameters<typeof prepareDocumentSnapshot>[1] };
  const prepared = await prepareDocumentSnapshot(request.document, request.token);
  return createPreparedMessage(request.token, prepared.bytes, prepared.checksum);
}

describe('persistence preparation worker client', () => {
  it('lazily creates a worker, transfers the clone buffers, and accepts exact output', async () => {
    const worker = new FakeWorker();
    let factoryCalls = 0;
    const client = new PersistencePreparationWorkerClient({ workerFactory: () => { factoryCalls += 1; return worker; }, requestIdFactory: () => 'client-request' });
    const live = document();
    expect(factoryCalls).toBe(0);
    const promise = client.prepare({ projectId: 'client-project', revision: live.revision, document: live });
    expect(factoryCalls).toBe(1);
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].transfer).toHaveLength(10);
    expect((worker.posted[0].message as { document: PatternDocument }).document).not.toBe(live);
    if (typeof structuredClone === 'function') {
      expect(worker.transferredDocuments[0]?.kind.byteLength).toBe(0);
      expect((worker.posted[0].message as { document: PatternDocument }).document.kind.byteLength).toBeGreaterThan(0);
    }
    worker.emit(await preparedResponse(worker));
    const capability = await promise;
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toHaveLength(0);
    expect(client.getRequestId(capability)).toBe('client-request');
    expect(live.kind.byteLength).toBeGreaterThan(0);
    client.dispose();
    expect(worker.terminated.count).toBe(1);
  });

  it('rejects a revision mismatch before creating a worker or transferring buffers', async () => {
    const worker = new FakeWorker();
    let factoryCalls = 0;
    const client = new PersistencePreparationWorkerClient({ workerFactory: () => { factoryCalls += 1; return worker; } });
    const live = document();
    const promise = client.prepare({ projectId: 'revision-mismatch', revision: live.revision + 1, document: live });

    await expect(promise).rejects.toMatchObject({ code: 'invalid-document' });
    expect(factoryCalls).toBe(0);
    expect(worker.posted).toHaveLength(0);
    client.dispose();
  });

  it('rejects malformed and stale responses for the exact pending identity', async () => {
    const worker = new FakeWorker();
    const client = new PersistencePreparationWorkerClient({ workerFactory: () => worker, requestIdFactory: () => 'strict-request' });
    const doc = document();
    const malformed = client.prepare({ projectId: 'malformed-client', revision: doc.revision, document: cloneDocument(doc) });
    const malformedRequest = worker.posted[0].message as { token: { projectId: string; revision: number; requestId: string } };
    worker.emit({
      protocol: 'needlewise-persistence-preparation-v1',
      type: 'prepared-document',
      token: malformedRequest.token,
      bytes: new Uint8Array(),
      checksum: '0'.repeat(64)
    });
    await expect(malformed).rejects.toMatchObject({ code: 'invalid-response' });

    const stale = client.prepare({ projectId: 'stale-client', revision: doc.revision, document: cloneDocument(doc) });
    const staleRequest = worker.posted[1].message as { token: { projectId: string; revision: number; requestId: string } };
    const prepared = await prepareDocumentSnapshot(doc, { ...staleRequest.token, revision: staleRequest.token.revision });
    worker.emit(createPreparedMessage({ ...staleRequest.token, revision: staleRequest.token.revision + 1 }, prepared.bytes, prepared.checksum));
    await expect(stale).rejects.toBeInstanceOf(PersistencePreparationStaleError);
    client.dispose();
  });

  it('recycles after error/messageerror and resolves work on the recreated worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new PersistencePreparationWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.prepare({ projectId: 'first', revision: 1, document: cloneDocument(document()), requestId: 'first-request' });
    workers[0].emitTransport('error', { message: 'crashed' });
    await expect(first).rejects.toBeInstanceOf(PersistencePreparationTransportError);
    expect(workers[0].terminated.count).toBe(1);

    const second = client.prepare({ projectId: 'second', revision: document().revision, document: cloneDocument(document()), requestId: 'second-request' });
    expect(workers).toHaveLength(2);
    workers[1].emit(await preparedResponse(workers[1]));
    const capability = await second;
    expect(client.getRequestId(capability)).toBe('second-request');
    client.dispose();
    expect(workers[1].terminated.count).toBe(1);
  });

  it('handles messageerror, worker errors, disposal, and transport cleanup', async () => {
    const worker = new FakeWorker();
    const client = new PersistencePreparationWorkerClient({ workerFactory: () => worker });
    const messageError = client.prepare({ projectId: 'message-error', revision: document().revision, document: cloneDocument(document()) });
    worker.emitTransport('messageerror', { message: 'bad clone' });
    await expect(messageError).rejects.toBeInstanceOf(PersistencePreparationTransportError);

    const workerError = new FakeWorker();
    const secondClient = new PersistencePreparationWorkerClient({ workerFactory: () => workerError });
    const failed = secondClient.prepare({ projectId: 'worker-error', revision: document().revision, document: cloneDocument(document()) });
    const request = workerError.posted[0].message as { token: { projectId: string; revision: number; requestId: string } };
    workerError.emit(createPreparationError(new PersistenceError('storage-failure', 'worker failure'), request.token));
    await expect(failed).rejects.toMatchObject({ code: 'storage-failure' });

    const disposedWorker = new FakeWorker();
    const disposedClient = new PersistencePreparationWorkerClient({ workerFactory: () => disposedWorker });
    const pending = disposedClient.prepare({ projectId: 'disposed', revision: document().revision, document: cloneDocument(document()) });
    disposedClient.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
    expect(disposedWorker.terminated.count).toBe(1);
    client.dispose();
    secondClient.dispose();
  });
});

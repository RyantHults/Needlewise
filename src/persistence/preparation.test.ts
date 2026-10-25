import { describe, expect, it } from 'vitest';
import { cloneLayeredDocument } from './binary';
import { sha256 } from './hash';
import {
  createPreparationRequest,
  createPreparedMessage,
  prepareDocumentSnapshot,
  preparationTransferList,
  type PersistencePreparationResponse,
  type PersistencePreparationToken
} from './preparation';
import { decodeDocumentWithInfo } from './binary';
import { handlePersistencePreparationWorkerMessage } from '../workers/persistence-preparation.worker';
import { stitchLayer } from '../domain/test-fixtures';
import { document } from './test-support';

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe('persistence preparation protocol and worker', () => {
  it('prepares worker bytes equivalent to the existing binary encoder and transfers only clone buffers', async () => {
    const live = document(0, 0);
    const clone = cloneLayeredDocument(live);
    const token: PersistencePreparationToken = { projectId: 'worker-project', revision: clone.revision, requestId: 'worker-request' };
    const request = createPreparationRequest(clone, token);
    const responses: Array<{ message: PersistencePreparationResponse; transfer?: Transferable[] }> = [];

    expect(preparationTransferList(clone)).toHaveLength(10);
    handlePersistencePreparationWorkerMessage(request, (message, transfer) => responses.push({ message, transfer }));
    await waitForTurn();

    expect(responses).toHaveLength(1);
    const response = responses[0].message;
    expect(response.type).toBe('prepared-document');
    if (response.type !== 'prepared-document') throw new Error('missing prepared response');
    const expectedBytes = (await prepareDocumentSnapshot(live, token)).bytes;
    expect(response.bytes).toEqual(expectedBytes);
    expect(decodeDocumentWithInfo(response.bytes).document.catalog).toEqual(live.catalog);
    expect(response.checksum).toBe(await sha256(expectedBytes));
    expect(responses[0].transfer).toEqual([response.bytes.buffer]);
    expect(stitchLayer(live).kind.byteLength).toBeGreaterThan(0);
  });

  it('returns protocol errors for malformed and revision-mismatched requests', async () => {
    const responses: PersistencePreparationResponse[] = [];
    handlePersistencePreparationWorkerMessage({ protocol: 'wrong', type: 'prepare-document' }, (message) => responses.push(message));
    handlePersistencePreparationWorkerMessage({
      ...createPreparationRequest(cloneLayeredDocument(document(0, 0)), { projectId: 'malformed', revision: 99, requestId: 'bad-revision' }),
      document: document(0, 0)
    }, (message) => responses.push(message));
    await waitForTurn();

    expect(responses).toHaveLength(2);
    expect(responses.every((response) => response.type === 'preparation-error')).toBe(true);
  });

  it('rejects duplicate active worker requests without disturbing the first request', async () => {
    const doc = cloneLayeredDocument(document(0, 0));
    const token: PersistencePreparationToken = { projectId: 'duplicate', revision: doc.revision, requestId: 'same' };
    const request = createPreparationRequest(doc, token);
    const responses: PersistencePreparationResponse[] = [];
    const active = new Set<string>();
    handlePersistencePreparationWorkerMessage(request, (message) => responses.push(message), active);
    handlePersistencePreparationWorkerMessage(request, (message) => responses.push(message), active);
    await waitForTurn();
    expect(responses.filter((response) => response.type === 'preparation-error')).toHaveLength(1);
    expect(responses.filter((response) => response.type === 'prepared-document')).toHaveLength(1);
  });

  it('builds a matching prepared response without cloning the supplied document', async () => {
    const doc = document(0, 0);
    const token: PersistencePreparationToken = { projectId: 'direct', revision: doc.revision, requestId: 'direct-request' };
    const prepared = await prepareDocumentSnapshot(doc, token);
    expect(prepared.projectId).toBe(token.projectId);
    expect(prepared.revision).toBe(token.revision);
    expect(prepared.requestId).toBe(token.requestId);
    expect(prepared.bytes).toEqual(await prepareDocumentSnapshot(doc, token).then((value) => value.bytes));
    expect(createPreparedMessage(token, prepared.bytes, prepared.checksum, prepared.summary).token).toEqual(token);
  });
});

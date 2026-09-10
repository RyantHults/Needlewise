import { describe, expect, it } from 'vitest';
import { CellKind } from '../domain';
import {
  FILL_CANCELLED_TYPE,
  FILL_RESULT_TYPE,
  createFillCancel,
  createFillRequest,
  type FillWorkerResponse
} from '../editor/fill';
import { handleFillWorkerMessage } from './fill.worker';

function request() {
  const kind = new Uint8Array([CellKind.Full, CellKind.Full]);
  const colors = new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0]);
  return createFillRequest({
    projectId: 'project-a',
    baseRevision: 0,
    requestId: 'worker-fill',
    width: 2,
    height: 1,
    startIndex: 0,
    startMask: 1,
    kind,
    colors
  });
}

describe('fill worker entrypoint', () => {
  it('returns component masks with the sorted traversal result', async () => {
    const messages: FillWorkerResponse[] = [];
    handleFillWorkerMessage(request(), (message) => messages.push(message));
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: FILL_RESULT_TYPE, indices: new Uint32Array([0, 1]), masks: new Uint8Array([1, 1]) });
  });

  it('acknowledges a cancellation queued before request processing', () => {
    const messages: FillWorkerResponse[] = [];
    const next = request();
    const cancelled = new Set<string>();
    handleFillWorkerMessage(createFillCancel(next), (message) => messages.push(message), cancelled);
    handleFillWorkerMessage(next, (message) => messages.push(message), cancelled);
    expect(messages).toMatchObject([{ type: FILL_CANCELLED_TYPE, requestId: 'worker-fill' }]);
  });

  it('expires an orphan pre-cancellation before a later full-identity reuse', async () => {
    const messages: FillWorkerResponse[] = [];
    const next = request();
    const cancelled = new Set<string>();
    handleFillWorkerMessage(createFillCancel(next), (message) => messages.push(message), cancelled);
    await Promise.resolve();
    handleFillWorkerMessage(next, (message) => messages.push(message), cancelled);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toMatchObject([{ type: FILL_RESULT_TYPE, requestId: 'worker-fill' }]);
  });

  it('ignores a cancellation with the same request ID but a different project or revision', async () => {
    const messages: FillWorkerResponse[] = [];
    const next = request();
    const cancelled = new Set<string>();
    handleFillWorkerMessage(createFillCancel({ ...next, projectId: 'project-b', baseRevision: 9 }), (message) => messages.push(message), cancelled);
    handleFillWorkerMessage(next, (message) => messages.push(message), cancelled);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toMatchObject([{ type: FILL_RESULT_TYPE, requestId: 'worker-fill' }]);
  });

  it('cancels genuinely in-flight traversal after its first 8192-node batch', async () => {
    const width = 100;
    const height = 100;
    const kind = new Uint8Array(width * height).fill(CellKind.Full);
    const colors = new Uint16Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) colors[index * 4] = 1;
    const request = createFillRequest({
      projectId: 'project-a',
      baseRevision: 3,
      requestId: 'in-flight-cancel',
      width,
      height,
      startIndex: 0,
      startMask: 1,
      kind,
      colors
    });
    const messages: FillWorkerResponse[] = [];
    const cancelled = new Set<string>();
    handleFillWorkerMessage(request, (message) => messages.push(message), cancelled);
    expect(messages).toHaveLength(0);
    handleFillWorkerMessage(createFillCancel(request), (message) => messages.push(message), cancelled);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages).toMatchObject([{ type: FILL_CANCELLED_TYPE, projectId: 'project-a', baseRevision: 3, requestId: 'in-flight-cancel' }]);
  });
});

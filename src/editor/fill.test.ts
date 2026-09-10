import { describe, expect, it } from 'vitest';
import { CellKind } from '../domain';
import {
  FILL_PROTOCOL,
  FILL_REQUEST_TYPE,
  FILL_RESULT_TYPE,
  FillCancelledError,
  FillProtocolError,
  FillStaleResultError,
  FillWorkerTransportError,
  type FillRequestInput,
  type FillWorkerLike,
  assertValidFillRequest,
  createFillRequest,
  createFillResult,
  createFillWorkerClient,
  runExactFloodFill,
  validateFillRequest
} from './fill';
import { ThreeQuarterPair } from './cell-kinds';

function input(
  width: number,
  height: number,
  startIndex: number,
  kind = new Uint8Array(width * height),
  colors = new Uint16Array(width * height * 4)
): FillRequestInput {
  return {
    projectId: 'project-a',
    baseRevision: 7,
    requestId: `request-${width}-${height}-${startIndex}`,
    width,
    height,
    startIndex,
    kind,
    colors
  };
}

class FakeWorker implements FillWorkerLike {
  readonly posted: unknown[] = [];
  readonly terminated = { count: 0 };
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.set(_type, listener as unknown as (event: unknown) => void);
  }

  emit(message: unknown): void {
    this.listeners.get('message')?.({ data: message });
  }

  emitTransport(type: 'error' | 'messageerror', event: unknown): void {
    this.listeners.get(type)?.(event);
  }

  terminate(): void {
    this.terminated.count += 1;
  }
}

describe('fill protocol and exact flood fill', () => {
  it('copies request planes and matches the complete geometry/color tuple', () => {
    const kind = new Uint8Array([1, 1, 1, 1, 1, 1]);
    const colors = new Uint16Array(6 * 4);
    colors[0] = 3;
    colors[4] = 3;
    colors[8] = 4;
    colors[12] = 3;
    colors[16] = 3;
    colors[20] = 3;
    const request = createFillRequest(input(3, 2, 0, kind, colors));

    expect(request.kind).not.toBe(kind);
    expect(request.colors).not.toBe(colors);
    expect(runExactFloodFill(request)).toEqual(new Uint32Array([0, 1, 3, 4, 5]));
  });

  it('accepts directional three-quarter kinds and keeps their directions as fill boundaries', () => {
    const kind = new Uint8Array([
      CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE,
      CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNW, CellKind.ThreeQuarterNE
    ]);
    const colors = new Uint16Array(6 * 4);
    colors[0] = 2;
    colors[4] = 2;
    colors[12] = 2;
    colors[16] = 2;
    const request = createFillRequest(input(3, 2, 0, kind, colors));
    expect(runExactFloodFill(request)).toEqual(new Uint32Array([0, 1, 3, 4]));
  });

  it('accepts paired three-quarter color/completion planes as exact fill tuples', () => {
    const kind = new Uint8Array([ThreeQuarterPair, ThreeQuarterPair, ThreeQuarterPair]);
    const colors = new Uint16Array(3 * 4);
    colors.set([1, 0, 2, 0], 0);
    colors.set([1, 0, 2, 0], 4);
    colors.set([1, 0, 3, 0], 8);
    const request = createFillRequest(input(3, 1, 0, kind, colors));
    expect(runExactFloodFill(request)).toEqual(new Uint32Array([0, 1]));
  });

  it('fills connected empty regions while respecting sparse boundaries', () => {
    const kind = new Uint8Array([
      0, 1, 0, 0,
      0, 1, 0, 0,
      0, 1, 0, 0
    ]);
    const request = createFillRequest(input(4, 3, 0, kind));
    expect(runExactFloodFill(request)).toEqual(new Uint32Array([0, 4, 8]));
    expect(runExactFloodFill(createFillRequest(input(4, 3, 2, kind)))).toEqual(new Uint32Array([2, 3, 6, 7, 10, 11]));
  });

  it('handles a bounded 250,000-cell region and returns sorted indices', () => {
    const request = createFillRequest(input(500, 500, 249_999));
    const result = runExactFloodFill(request);
    expect(result.length).toBe(250_000);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(249_999);
  });

  it('supports cooperative cancellation', () => {
    const request = createFillRequest(input(20, 20, 0));
    expect(() => runExactFloodFill(request, { isCancelled: () => true })).toThrow(FillCancelledError);
  });

  it('rejects malformed dimensions, indices, planes, and protocol tags', () => {
    expect(validateFillRequest({ ...createFillRequest(input(2, 2, 0)), width: 0 })).toBe(false);
    expect(validateFillRequest({ ...createFillRequest(input(2, 2, 0)), startIndex: 4 })).toBe(false);
    expect(validateFillRequest({
      ...createFillRequest(input(2, 2, 0)),
      colors: new Uint16Array(3)
    })).toBe(false);
    expect(validateFillRequest({ ...createFillRequest(input(2, 2, 0)), protocol: 'other' })).toBe(false);
    expect(() => assertValidFillRequest({
      protocol: FILL_PROTOCOL,
      type: FILL_REQUEST_TYPE,
      projectId: 'project-a',
      baseRevision: 7,
      requestId: 'bad',
      width: 2,
      height: 2,
      startIndex: 0,
      kind: new Uint8Array([0, 0, 0, 0]),
      colors: new Uint16Array(3)
    })).toThrow(FillProtocolError);
  });

  it('uses the fallback adapter when no Worker is available', async () => {
    const client = createFillWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'fallback-request' });
    const result = await client.request(input(2, 2, 0));
    expect(result.type).toBe(FILL_RESULT_TYPE);
    expect(result.indices).toEqual(new Uint32Array([0, 1, 2, 3]));
    client.dispose();
  });

  it('rejects cancelled jobs and ignores responses after cancellation', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input(2, 2, 0));
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(FillCancelledError);
    expect(worker.posted).toHaveLength(2);
    worker.emit({ ...createFillResult(job.request, new Uint32Array([0])) });
    client.dispose();
  });

  it('filters stale project, revision, and request results at the client boundary', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input(2, 2, 0));
    const stale = createFillResult(job.request, new Uint32Array([0]));
    worker.emit({ ...stale, projectId: 'project-b' });
    await expect(job.promise).rejects.toBeInstanceOf(FillStaleResultError);

    const second = client.submit({ ...input(2, 2, 0), requestId: 'second' });
    worker.emit({ ...createFillResult(second.request, new Uint32Array([0])), requestId: 'not-second' });
    expect(worker.posted).toHaveLength(2);
    worker.emit(createFillResult(second.request, new Uint32Array([0, 1, 2, 3])));
    await expect(second.promise).resolves.toMatchObject({ requestId: 'second' });

    const third = client.submit({ ...input(2, 2, 0), requestId: 'third' });
    worker.emit({ ...createFillResult(third.request, new Uint32Array([0])), baseRevision: 8 });
    await expect(third.promise).rejects.toBeInstanceOf(FillStaleResultError);
    client.dispose();
  });

  it('rejects malformed worker results', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input(2, 2, 0));
    worker.emit({
      ...job.request,
      type: FILL_RESULT_TYPE,
      indices: new Uint16Array([0])
    });
    await expect(job.promise).rejects.toBeInstanceOf(FillProtocolError);
    client.dispose();
  });

  it('rejects all pending jobs and recycles the worker on transport errors', async () => {
    const workers: FakeWorker[] = [];
    const client = createFillWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.submit({ ...input(2, 2, 0), requestId: 'transport-one' });
    const second = client.submit({ ...input(2, 2, 0), requestId: 'transport-two' });
    workers[0].emitTransport('error', { message: 'worker crashed' });
    await expect(first.promise).rejects.toBeInstanceOf(FillWorkerTransportError);
    await expect(second.promise).rejects.toBeInstanceOf(FillWorkerTransportError);
    expect(workers[0].terminated.count).toBe(1);

    const recycled = client.submit({ ...input(2, 2, 0), requestId: 'transport-three' });
    expect(workers).toHaveLength(2);
    workers[1].emitTransport('messageerror', { message: 'bad clone' });
    await expect(recycled.promise).rejects.toBeInstanceOf(FillWorkerTransportError);
    expect(workers[1].terminated.count).toBe(1);
    client.dispose();
  });
});

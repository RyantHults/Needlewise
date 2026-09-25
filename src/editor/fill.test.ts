import { describe, expect, it } from 'vitest';
import { CellKind } from '../domain';
import {
  FILL_CANCELLED_TYPE,
  FILL_ERROR_TYPE,
  FILL_PROTOCOL,
  FILL_REQUEST_TYPE,
  FILL_RESULT_TYPE,
  FillCancelledError,
  FillProtocolError,
  FillWorkerTransportError,
  type FillRequestInput,
  type FillWorkerLike,
  assertValidFillRequest,
  createFillCancel,
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
  kind?: Uint8Array,
  colors?: Uint16Array,
  startMask = 1
): FillRequestInput {
  const nextKind = kind ?? new Uint8Array(width * height).fill(CellKind.Full);
  const nextColors = colors ?? new Uint16Array(width * height * 4);
  if (!kind) for (let index = 0; index < width * height; index += 1) nextColors[index * 4] = 1;
  return {
    projectId: 'project-a',
    baseRevision: 7,
    requestId: `request-${width}-${height}-${startIndex}`,
    width,
    height,
    startIndex,
    startMask,
    kind: nextKind,
    colors: nextColors
  };
}

class FakeWorker implements FillWorkerLike {
  readonly posted: unknown[] = [];
  readonly terminated = { count: 0 };
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void { this.posted.push(message); }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void { this.listeners.set(_type, listener as unknown as (event: unknown) => void); }
  emit(message: unknown): void { this.listeners.get('message')?.({ data: message }); }
  emitTransport(type: 'error' | 'messageerror', event: unknown): void { this.listeners.get(type)?.(event); }
  terminate(): void { this.terminated.count += 1; }
}

function fullGrid(width: number, height: number, color = 1): { kind: Uint8Array; colors: Uint16Array } {
  const kind = new Uint8Array(width * height).fill(CellKind.Full);
  const colors = new Uint16Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) colors[index * 4] = color;
  return { kind, colors };
}

describe('component-graph fill protocol and traversal', () => {
  it('copies planes and returns aligned masks for a Full component graph', () => {
    const planes = fullGrid(3, 2, 3);
    const request = createFillRequest(input(3, 2, 0, planes.kind, planes.colors));
    expect(request.kind).not.toBe(planes.kind);
    expect(request.colors).not.toBe(planes.colors);
    const result = runExactFloodFill(request);
    expect(result.indices).toEqual(new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(result.masks).toEqual(new Uint8Array([1, 1, 1, 1, 1, 1]));
  });

  it('connects compatible components across a shared edge but not a diagonal-only contact', () => {
    const kind = new Uint8Array([CellKind.Quarters, CellKind.Quarters, CellKind.Quarters]);
    const colors = new Uint16Array(12);
    colors.set([0, 5, 0, 0], 0); // NE: right edge [0,.5]
    colors.set([5, 0, 0, 0], 4); // NW: left edge [0,.5]
    colors.set([0, 0, 0, 5], 8); // SW: left edge [.5,1], endpoint-only contact
    const request = createFillRequest(input(3, 1, 0, kind, colors, 2));
    const result = runExactFloodFill(request);
    expect(result.indices).toEqual(new Uint32Array([0, 1]));
    expect(result.masks).toEqual(new Uint8Array([2, 1]));
  });

  it('does not connect sibling components in one cell or different logical corners', () => {
    const kind = new Uint8Array([ThreeQuarterPair, ThreeQuarterPair]);
    const colors = new Uint16Array(8);
    colors.set([5, 0, 5, 0], 0);
    colors.set([0, 5, 0, 5], 4);
    const nw = runExactFloodFill(createFillRequest(input(2, 1, 0, kind, colors, 1)));
    expect(nw.indices).toEqual(new Uint32Array([0]));
    expect(nw.masks).toEqual(new Uint8Array([1]));
    const se = runExactFloodFill(createFillRequest(input(2, 1, 0, kind, colors, 4)));
    expect(se.indices).toEqual(new Uint32Array([0]));
    expect(se.masks).toEqual(new Uint8Array([4]));
  });

  it('connects directional three-quarter components by logical corner horizontally and vertically on both pair axes', () => {
    const run = (width: number, height: number, colors: [number, number, number, number], startMask: number, expected: number[]): void => {
      const kind = new Uint8Array(width * height).fill(ThreeQuarterPair);
      const plane = new Uint16Array(width * height * 4);
      for (let index = 0; index < width * height; index += 1) plane.set(colors, index * 4);
      const result = runExactFloodFill(createFillRequest(input(width, height, 0, kind, plane, startMask)));
      expect(result.indices).toEqual(new Uint32Array(expected));
      expect(result.masks).toEqual(new Uint8Array(expected.length).fill(startMask));
    };

    run(3, 1, [1, 0, 2, 0], 1, [0, 1, 2]);
    run(1, 3, [1, 0, 2, 0], 1, [0, 1, 2]);
    run(3, 1, [0, 1, 0, 2], 2, [0, 1, 2]);
    run(1, 3, [0, 1, 0, 2], 2, [0, 1, 2]);

    const differentAxisKind = new Uint8Array([ThreeQuarterPair, ThreeQuarterPair]);
    const differentAxisColors = new Uint16Array([1, 0, 2, 0, 0, 1, 0, 2]);
    const differentAxis = runExactFloodFill(createFillRequest(input(2, 1, 0, differentAxisKind, differentAxisColors, 1)));
    expect(differentAxis.indices).toEqual(new Uint32Array([0]));
    expect(differentAxis.masks).toEqual(new Uint8Array([1]));
  });

  it('connects single directional three-quarter components by logical corner without connecting different corners', () => {
    const horizontalKind = new Uint8Array([CellKind.ThreeQuarterNE, CellKind.ThreeQuarterNE, CellKind.ThreeQuarterNE]);
    const horizontalColors = new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const horizontal = runExactFloodFill(createFillRequest(input(3, 1, 0, horizontalKind, horizontalColors)));
    expect(horizontal.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(horizontal.masks).toEqual(new Uint8Array([1, 1, 1]));

    const verticalKind = new Uint8Array([CellKind.ThreeQuarterSW, CellKind.ThreeQuarterSW]);
    const verticalColors = new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0]);
    const vertical = runExactFloodFill(createFillRequest(input(1, 2, 0, verticalKind, verticalColors)));
    expect(vertical.indices).toEqual(new Uint32Array([0, 1]));
    expect(vertical.masks).toEqual(new Uint8Array([1, 1]));

    const differentCornerKind = new Uint8Array([CellKind.ThreeQuarterNE, CellKind.ThreeQuarterSW]);
    const differentCornerColors = new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0]);
    const differentCorner = runExactFloodFill(createFillRequest(input(2, 1, 0, differentCornerKind, differentCornerColors)));
    expect(differentCorner.indices).toEqual(new Uint32Array([0]));
    expect(differentCorner.masks).toEqual(new Uint8Array([1]));
  });

  it('uses source color and component geometry rather than whole-cell tuples', () => {
    const kind = new Uint8Array([CellKind.HalfBackslash, CellKind.HalfSlash, CellKind.Full, CellKind.Full]);
    const colors = new Uint16Array(16);
    colors.set([7, 0, 0, 0], 0);
    colors.set([7, 0, 0, 0], 4);
    colors.set([7, 0, 0, 0], 8);
    colors.set([8, 0, 0, 0], 12);
    const result = runExactFloodFill(createFillRequest(input(4, 1, 0, kind, colors)));
    expect(result.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(result.masks).toEqual(new Uint8Array([1, 1, 1]));
  });

  it('rejects malformed masks and protocol payloads', () => {
    const request = createFillRequest(input(2, 1, 0));
    expect(validateFillRequest({ ...request, startMask: 3 })).toBe(false);
    expect(validateFillRequest({ ...request, protocol: 'needlewise.fill.v1' })).toBe(false);
    expect(() => assertValidFillRequest({
      protocol: FILL_PROTOCOL,
      type: FILL_REQUEST_TYPE,
      projectId: 'project-a',
      baseRevision: 7,
      requestId: 'bad',
      width: 2,
      height: 1,
      startIndex: 0,
      startMask: 1,
      kind: new Uint8Array([CellKind.Full, CellKind.Full]),
      colors: new Uint16Array(3)
    })).toThrow(FillProtocolError);
    expect(() => createFillResult(request, new Uint32Array([0]), undefined as unknown as Uint8Array)).toThrow(FillProtocolError);
    expect(() => createFillResult(request, new Uint32Array([0]), new Uint8Array())).toThrow(FillProtocolError);
  });

  it('fills only the four-connected empty region and stops at occupied neighbors', () => {
    const kind = new Uint8Array(12).fill(CellKind.Empty);
    const colors = new Uint16Array(12 * 4);
    for (const index of [2, 7, 8]) {
      kind[index] = CellKind.Full;
      colors[index * 4] = 1;
    }
    const request = createFillRequest(input(4, 3, 0, kind, colors));
    const result = runExactFloodFill(request);

    expect(result.indices).toEqual(new Uint32Array([0, 1, 4, 5, 6, 9, 10, 11]));
    expect(result.masks).toEqual(new Uint8Array(8).fill(1));
  });

  it('follows compatible components across vertical edges and rejects endpoint-only topology', () => {
    const kind = new Uint8Array([CellKind.Quarters, CellKind.Quarters]);
    const colors = new Uint16Array(8);
    colors.set([0, 0, 7, 0], 0); // top SE: bottom edge [.5,1]
    colors.set([0, 7, 0, 0], 4); // bottom NE: top edge [.5,1]
    const connected = runExactFloodFill(createFillRequest(input(1, 2, 0, kind, colors, 4)));
    expect(connected.indices).toEqual(new Uint32Array([0, 1]));
    expect(connected.masks).toEqual(new Uint8Array([4, 2]));

    colors.set([0, 0, 7, 0], 0); // top SE: bottom edge [.5,1]
    colors.set([7, 0, 0, 0], 4); // bottom NW: top edge [0,.5], endpoint only
    const separated = runExactFloodFill(createFillRequest(input(1, 2, 0, kind, colors, 4)));
    expect(separated.indices).toEqual(new Uint32Array([0]));
    expect(separated.masks).toEqual(new Uint8Array([4]));
  });

  it('handles a bounded graph and cooperative cancellation', () => {
    const planes = fullGrid(500, 500, 1);
    const result = runExactFloodFill(createFillRequest(input(500, 500, 0, planes.kind, planes.colors)));
    expect(result.indices.length).toBe(250_000);
    expect(result.masks.every((mask) => mask === 1)).toBe(true);
    expect(() => runExactFloodFill(createFillRequest(input(20, 20, 0)), { isCancelled: () => true })).toThrow(FillCancelledError);
  });

  it('uses the fallback client and transfers component masks through worker results', async () => {
    const client = createFillWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'fallback-request' });
    const result = await client.request(input(2, 2, 0));
    expect(result.type).toBe(FILL_RESULT_TYPE);
    expect(result.indices).toEqual(new Uint32Array([0, 1, 2, 3]));
    expect(result.masks).toEqual(new Uint8Array([1, 1, 1, 1]));
    client.dispose();
  });

  it('keys cancellation and stale responses by the complete request identity', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input(2, 2, 0));
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(FillCancelledError);
    worker.emit(createFillResult(job.request, new Uint32Array([0]), new Uint8Array([1])));

    const stale = client.submit({ ...input(2, 2, 0), requestId: 'stale' });
    worker.emit({ ...createFillResult(stale.request, new Uint32Array([0]), new Uint8Array([1])), baseRevision: 8 });
    worker.emit({ ...createFillCancel(stale.request), baseRevision: 8 });
    worker.emit({ protocol: FILL_PROTOCOL, type: FILL_ERROR_TYPE, projectId: 'project-a', baseRevision: 8, requestId: stale.request.requestId, code: 'stale', message: 'stale' });
    worker.emit(createFillResult(stale.request, new Uint32Array([0]), new Uint8Array([1])));
    await expect(stale.promise).resolves.toMatchObject({ requestId: 'stale' });

    const first = client.submit({ ...input(2, 2, 0), requestId: 'reused', baseRevision: 7 });
    first.cancel();
    await expect(first.promise).rejects.toBeInstanceOf(FillCancelledError);
    const second = client.submit({ ...input(2, 2, 0), requestId: 'reused', baseRevision: 8 });
    worker.emit(createFillResult(first.request, new Uint32Array([0]), new Uint8Array([1])));
    worker.emit(createFillResult(second.request, new Uint32Array([0]), new Uint8Array([1])));
    await expect(second.promise).resolves.toMatchObject({ baseRevision: 8, requestId: 'reused' });
    client.dispose();
  });

  it('does not send cancellation for a request aborted before it is sent', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const signal = new AbortController();
    signal.abort();
    const job = client.submit(input(2, 2, 0), { signal: signal.signal });
    await expect(job.promise).rejects.toBeInstanceOf(FillCancelledError);
    expect(worker.posted).toHaveLength(0);
    client.dispose();
  });

  it('rejects a malformed response with matching identity but ignores malformed identity responses', async () => {
    const worker = new FakeWorker();
    const client = createFillWorkerClient({ workerFactory: () => worker });
    const ignored = client.submit({ ...input(2, 2, 0), requestId: 'identity-check' });
    worker.emit({ protocol: FILL_PROTOCOL, type: FILL_RESULT_TYPE, projectId: 'project-b', baseRevision: 7, requestId: ignored.request.requestId, width: 2, height: 2, startIndex: 0, startMask: 1, indices: new Uint32Array([0]), masks: new Uint8Array([1]) });
    worker.emit({ protocol: FILL_PROTOCOL, type: FILL_CANCELLED_TYPE, projectId: 'project-b', baseRevision: 7, requestId: ignored.request.requestId });
    worker.emit(createFillResult(ignored.request, new Uint32Array([0]), new Uint8Array([1])));
    await expect(ignored.promise).resolves.toMatchObject({ requestId: 'identity-check' });

    const malformed = client.submit({ ...input(2, 2, 0), requestId: 'malformed-response' });
    worker.emit({ ...malformed.request, type: FILL_RESULT_TYPE, indices: new Uint32Array([0]), masks: undefined });
    await expect(malformed.promise).rejects.toBeInstanceOf(FillProtocolError);
    client.dispose();
  });

  it('rejects malformed worker results and recycles failed workers', async () => {
    const workers: FakeWorker[] = [];
    const client = createFillWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.submit(input(2, 2, 0));
    workers[0].emit({ ...first.request, type: FILL_RESULT_TYPE, indices: new Uint16Array([0]), masks: new Uint8Array([1]) });
    await expect(first.promise).rejects.toBeInstanceOf(FillProtocolError);
    const second = client.submit({ ...input(2, 2, 0), requestId: 'transport' });
    workers[0].emitTransport('error', { message: 'worker crashed' });
    await expect(second.promise).rejects.toBeInstanceOf(FillWorkerTransportError);
    expect(workers[0].terminated.count).toBe(1);
    client.dispose();
  });
});

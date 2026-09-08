import { describe, expect, it } from 'vitest';
import {
  ConversionCancelledError,
  ConversionWorkerTransportError,
  createConversionWorkerClient,
  type ConversionWorkerLike
} from './image-conversion-client';
import { convertConversionRequest, convertRasterToPattern, MAX_CONVERSION_TOKEN_BOOKKEEPING, type ConversionRequestMessage, type ConversionRasterRequestMessage, type ConversionWorkerResponse } from './image-to-pattern';

const passthroughCatalog = [
  { sourceId: 'red', code: '666', name: 'Red', hex: '#FF0000' as const, rgb: [255, 0, 0] as const },
  { sourceId: 'blue', code: '797', name: 'Blue', hex: '#0000FF' as const, rgb: [0, 0, 255] as const }
];

function input(requestId = 'request') {
  return {
    projectId: 'project-a',
    baseRevision: 7,
    requestId,
    targetWidth: 2,
    targetHeight: 1,
    raster: { width: 2, height: 1, pixels: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }
  };
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function imageBlob(): Blob {
  return new Blob([pngBytes(1, 1).buffer as ArrayBuffer], { type: 'image/png' });
}

class FakeWorker implements ConversionWorkerLike {
  readonly posted: unknown[] = [];
  readonly terminated = { count: 0 };
  private readonly listeners = new Map<string, (event: unknown) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.set(type, listener as unknown as (event: unknown) => void);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
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

describe('image conversion worker client', () => {
  it('uses the fallback conversion when no worker is available', async () => {
    const client = createConversionWorkerClient({ workerFactory: () => null, requestIdFactory: () => 'fallback' });
    const result = await client.request({ ...input(), requestId: undefined });
    expect(result.draft.document.width).toBe(2);
    expect(result.token.requestId).toBe('fallback');
    client.dispose();
  });

  it('sends copied transient raster data to a worker and accepts matching results', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input());
    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0] as ConversionRasterRequestMessage;
    expect(request.pixels).not.toBe((job.request as ConversionRequestMessage & { readonly pixels: Uint8ClampedArray }).pixels);
    worker.emit(convertConversionRequest(request));
    await expect(job.promise).resolves.toMatchObject({ token: job.request.token });
    client.dispose();
  });

  it('forwards backgroundSourceId to the worker request and drops the color from the result palette', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit({ ...input(), catalog: passthroughCatalog, backgroundSourceId: 'blue' });
    const posted = worker.posted[0] as ConversionRasterRequestMessage;
    expect(posted.backgroundSourceId).toBe('blue');
    worker.emit(convertConversionRequest(posted));
    await expect(job.promise).resolves.toMatchObject({ token: job.request.token });
    const result = await job.promise;
    expect(result.draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    client.dispose();
  });

  it('applies backgroundSourceId on the fallback path without a worker', async () => {
    const client = createConversionWorkerClient({ useWorker: false });
    const result = await client.request({
      ...input('background-fallback'),
      catalog: passthroughCatalog,
      backgroundSourceId: 'blue'
    });
    expect(result.draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    client.dispose();
  });

  it('forwards autoCrop to the worker request and trims empty pattern borders', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const bordered = new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0
    ]);
    const job = client.submit({ ...input(), catalog: passthroughCatalog, autoCrop: true, targetWidth: 4, targetHeight: 2, raster: { width: 4, height: 2, pixels: bordered } });
    const posted = worker.posted[0] as ConversionRasterRequestMessage;
    expect(posted.autoCrop).toBe(true);
    worker.emit(convertConversionRequest(posted));
    const result = await job.promise;
    // Source dims stay original; the pattern trims to the stitched 2x1 box.
    expect(result.draft.stats.sourceWidth).toBe(4);
    expect(result.draft.stats.sourceHeight).toBe(2);
    expect(result.draft.document.width).toBe(2);
    expect(result.draft.document.height).toBe(1);
    expect(result.draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    client.dispose();
  });

  it('rejects cancellation and ignores a later worker response', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input());
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(worker.posted).toHaveLength(2);
    worker.emit(convertConversionRequest(job.request));
    client.dispose();
  });

  it('rejects stale responses and recycles the worker after transport failure', async () => {
    const workers: FakeWorker[] = [];
    const client = createConversionWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.submit(input());
    const firstResult = convertConversionRequest(first.request);
    first.cancel();
    await expect(first.promise).rejects.toBeInstanceOf(ConversionCancelledError);

    const second = client.submit({ ...input(), projectId: 'project-b', baseRevision: 8 });
    // Reusing only requestId must not let the cancelled first result touch the
    // newer full-token job.
    workers[0].emit(firstResult);
    workers[0].emit(convertConversionRequest(second.request));
    await expect(second.promise).resolves.toMatchObject({ token: second.request.token });

    const third = client.submit(input('third'));
    workers[0].emitTransport('error', { message: 'worker crashed' });
    await expect(third.promise).rejects.toBeInstanceOf(ConversionWorkerTransportError);
    expect(workers[0].terminated.count).toBe(1);
    client.dispose();
  });

  it('accepts worker error responses for the matching request', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input());
    const response = {
      protocol: job.request.protocol,
      type: 'conversion-error' as const,
      token: job.request.token,
      code: 'too-large',
      message: 'too large'
    } satisfies ConversionWorkerResponse;
    worker.emit(response);
    await expect(job.promise).rejects.toMatchObject({ code: 'too-large' });
    client.dispose();
  });

  it('ignores responses without a full token and refuses ambiguous request-ID cancellation', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const first = client.submit(input('shared-request'));
    const second = client.submit({ ...input('shared-request'), projectId: 'project-b', baseRevision: 8 });
    worker.emit({ protocol: first.request.protocol, type: 'conversion-error', code: 'missing-token', message: 'ignored' });
    expect(client.cancel('shared-request')).toBe(false);
    worker.emit(convertConversionRequest(second.request));
    await expect(second.promise).resolves.toMatchObject({ token: second.request.token });
    first.cancel();
    await expect(first.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    client.dispose();
  });

  it('sends image blobs to a worker without decoding them on the main thread', async () => {
    const worker = new FakeWorker();
    let mainThreadDecodeCalls = 0;
    const client = createConversionWorkerClient({
      workerFactory: () => worker,
      rasterOptions: { createImageBitmap: async () => { mainThreadDecodeCalls += 1; return { width: 1, height: 1 }; } }
    });
    const job = client.submitImage(imageBlob(), { ...input(), requestId: 'image-worker' });
    expect((worker.posted[0] as { inputType?: string }).inputType).toBe('image');
    expect(mainThreadDecodeCalls).toBe(0);
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    client.dispose();
  });

  it('falls back to bounded main-thread rasterization when the worker lacks image decoding', async () => {
    const worker = new FakeWorker();
    let decodeCalls = 0;
    const client = createConversionWorkerClient({
      workerFactory: () => worker,
      rasterOptions: {
        createImageBitmap: async () => { decodeCalls += 1; return { width: 1, height: 1 }; },
        surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } })
      }
    });
    const job = client.submitImage(imageBlob(), { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'worker-decode-fallback' });
    worker.emit({ protocol: job.request.protocol, type: 'conversion-error', token: job.request.token, code: 'unavailable', message: 'no OffscreenCanvas' });
    await expect(job.promise).resolves.toMatchObject({ token: job.request.token });
    expect(decodeCalls).toBe(1);
    client.dispose();
  });

  it('cancels a fallback image before decode starts', async () => {
    let decodeCalls = 0;
    const client = createConversionWorkerClient({
      useWorker: false,
      rasterOptions: { createImageBitmap: async () => { decodeCalls += 1; return { width: 1, height: 1 }; } }
    });
    const job = client.submitImage(imageBlob(), { ...input(), requestId: 'cancel-before-decode' });
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(decodeCalls).toBe(0);
    client.dispose();
  });

  it('cancels a fallback image while decode is pending and releases the bitmap', async () => {
    let resolveBitmap!: (bitmap: { width: number; height: number; close: () => void }) => void;
    let closed = 0;
    const client = createConversionWorkerClient({
      useWorker: false,
      rasterOptions: {
        createImageBitmap: async () => new Promise((resolve) => { resolveBitmap = (bitmap) => resolve(bitmap); }),
        surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } })
      }
    });
    const job = client.submitImage(imageBlob(), { ...input(), requestId: 'cancel-during-decode' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    job.cancel();
    resolveBitmap({ width: 1, height: 1, close: () => { closed += 1; } });
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(closed).toBe(1);
    client.dispose();
  });

  it('keeps worker and fallback conversion results equivalent', async () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
    const surfaceFactory = () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: pixels }) } });
    const client = createConversionWorkerClient({ useWorker: false, rasterOptions: {
      createImageBitmap: async () => ({ width: 1, height: 1 }),
      surfaceFactory
    } });
    const result = await client.requestImage(imageBlob(), { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'fallback-parity' });
    const expected = convertRasterToPattern({ width: 1, height: 1, pixels }, { targetWidth: 1, targetHeight: 1, token: result.token });
    expect(result.draft.document.kind).toEqual(expected.document.kind);
    expect(result.draft.document.colors).toEqual(expected.document.colors);
    client.dispose();
  });

  it('serializes fallback rasterization and conversion to one active main-thread job', async () => {
    let active = 0;
    let maximumActive = 0;
    const client = createConversionWorkerClient({ useWorker: false, rasterOptions: {
      createImageBitmap: async () => ({ width: 1, height: 1 }),
      surfaceFactory: () => {
        // The factory itself is the expensive target allocation boundary.
        // Queueing must keep this count at one.
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return {
          context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(8).fill(255) }) },
          dispose: () => { active -= 1; }
        };
      }
    } });
    const jobs = Array.from({ length: 4 }, (_, index) => {
      const job = client.submitImage(imageBlob(), { ...input(`serialized-${index}`) });
      return job.promise;
    });
    await Promise.all(jobs);
    expect(maximumActive).toBe(1);
    client.dispose();
  });

  it('tears down pending work and ignores late messages after disposal', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input('dispose-pending'));
    client.dispose();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(worker.terminated.count).toBe(1);
    worker.emit(convertConversionRequest(job.request));
    expect(() => client.submit(input('after-dispose'))).toThrow();
  });

  it('cancels during a long fallback mapping loop without accepting a late result', async () => {
    const width = 200;
    const height = 200;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      pixels[offset] = 10;
      pixels[offset + 1] = 20;
      pixels[offset + 2] = 30;
      pixels[offset + 3] = 255;
    }
    const controller = new AbortController();
    const client = createConversionWorkerClient({ useWorker: false });
    const job = client.submit({ ...input('long-fallback'), targetWidth: width, targetHeight: height, raster: { width, height, pixels } }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.cancel(job.request.token)).toBe(false);
    client.dispose();
  });

  it('removes cancelled queued fallback jobs so the bounded queue can accept replacement work', async () => {
    let resolveBitmap!: (bitmap: { width: number; height: number; close: () => void }) => void;
    const bitmapGate = new Promise<{ width: number; height: number; close: () => void }>((resolve) => { resolveBitmap = resolve; });
    const client = createConversionWorkerClient({ useWorker: false, rasterOptions: {
      createImageBitmap: async () => bitmapGate,
      surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } })
    } });
    const source = imageBlob();
    const first = client.submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-active' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = Array.from({ length: 32 }, (_, index) => client.submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: `queue-${index}` }));
    const busy = client.submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-busy' });
    for (const job of queued) job.cancel();
    const replacement = client.submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-replacement' });
    await Promise.all(queued.map((job) => expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError)));
    await expect(busy.promise).rejects.toMatchObject({ code: 'main-thread-busy' });
    resolveBitmap({ width: 1, height: 1, close: () => undefined });
    await expect(first.promise).resolves.toBeTruthy();
    await expect(replacement.promise).resolves.toBeTruthy();
    client.dispose();
  });

  it('bounds token retirement bookkeeping while preserving full-token uniqueness', async () => {
    const client = createConversionWorkerClient({ useWorker: false });
    let lastRequestId = '';
    for (let revision = 0; revision < MAX_CONVERSION_TOKEN_BOOKKEEPING + 100; revision += 1) {
      const result = await client.request({
        ...input('retired-request'),
        baseRevision: revision,
        targetWidth: 1,
        targetHeight: 1,
        raster: { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }
      });
      lastRequestId = result.token.requestId;
    }
    expect(client.tokenBookkeepingSize).toBe(MAX_CONVERSION_TOKEN_BOOKKEEPING);
    expect(lastRequestId).not.toBe('retired-request');
    client.dispose();
  });
});

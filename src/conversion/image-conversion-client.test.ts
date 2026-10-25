import { describe, expect, it } from 'vitest';
import {
  ConversionCancelledError,
  ConversionWorkerTransportError,
  createConversionWorkerClient
} from './image-conversion-client';
import { CONVERSION_CANCEL_TYPE, convertConversionRequestAsync, convertRasterToPatternAsync, type ConversionRequestMessage, type ConversionRasterRequestMessage, type ConversionWorkerResponse } from './image-to-pattern';
import type { CatalogSnapshot } from '../catalog';
import { FakeWorker } from '../test/fake-worker';

const passthroughCatalog: CatalogSnapshot = {
  association: { catalogId: 'passthrough-catalog', brandLabel: 'Passthrough', colorCount: 2 },
  records: [
    { sourceId: 'red', code: '666', name: 'Red', hex: '#FF0000' as const, rgb: [255, 0, 0] as const },
    { sourceId: 'blue', code: '797', name: 'Blue', hex: '#0000FF' as const, rgb: [0, 0, 255] as const }
  ]
};

function input(requestId = 'request') {
  return {
    projectId: 'project-a',
    baseRevision: 7,
    requestId,
    targetWidth: 2,
    targetHeight: 1,
    catalog: passthroughCatalog,
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

function mislabeledWebpBlob(): Blob {
  const width = 1_057;
  const height = 1_600;
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0], 0);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
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
    const source = input();
    const job = client.submit(source);
    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0] as ConversionRasterRequestMessage;
    expect(request.pixels).not.toBe(source.raster.pixels);
    expect(request.catalog).not.toBe(passthroughCatalog);
    expect(request.catalog).toEqual(passthroughCatalog);
    worker.emit(await convertConversionRequestAsync(request));
    await expect(job.promise).resolves.toMatchObject({ token: request.token, draft: { document: { catalog: passthroughCatalog.association } } });
    client.dispose();
  });

  it('forwards conversion options to the worker request and honours them in the result', async () => {
    async function viaWorker(overrides: Partial<ReturnType<typeof input>> & { autoCrop?: boolean; confettiDistance?: number; backgroundSourceId?: string }) {
      const worker = new FakeWorker();
      const client = createConversionWorkerClient({ workerFactory: () => worker });
      const job = client.submit({ ...input(), ...overrides });
      const posted = worker.posted[0] as ConversionRasterRequestMessage;
      worker.emit(await convertConversionRequestAsync(posted));
      const result = await job.promise;
      client.dispose();
      return { posted, result };
    }

    const background = await viaWorker({ backgroundSourceId: 'blue' });
    expect(background.posted.backgroundSourceId).toBe('blue');
    expect(background.result.draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);

    const bordered = new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0
    ]);
    const cropped = await viaWorker({ autoCrop: true, targetWidth: 4, targetHeight: 2, raster: { width: 4, height: 2, pixels: bordered } });
    expect(cropped.posted.autoCrop).toBe(true);
    // Source dims stay original; the pattern trims to the stitched 2x1 box.
    expect([cropped.result.draft.stats.sourceWidth, cropped.result.draft.stats.sourceHeight]).toEqual([4, 2]);
    expect([cropped.result.draft.document.width, cropped.result.draft.document.height]).toEqual([2, 1]);

    expect((await viaWorker({ confettiDistance: 2 })).posted.confettiDistance).toBe(2);
  });

  it('applies backgroundSourceId on the fallback path without a worker', async () => {
    const client = createConversionWorkerClient({ useWorker: false });
    const result = await client.request({
      ...input('background-fallback'),
      catalog: passthroughCatalog,
      backgroundSourceId: 'blue'
    });
    expect(result.draft.document.palette.map((entry) => entry.catalog?.sourceId)).toEqual(['red']);
    expect(result.draft.document.catalog).toEqual(passthroughCatalog.association);
    client.dispose();
  });

  it('rejects cancellation, tells the worker, and ignores a later worker response', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input());
    const request = worker.posted[0] as ConversionRasterRequestMessage;
    job.cancel();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(worker.posted.at(-1)).toMatchObject({ type: CONVERSION_CANCEL_TYPE, token: request.token });
    worker.emit(await convertConversionRequestAsync(request));
    client.dispose();
  });

  it('ignores results for another token and recycles the worker after transport failure', async () => {
    const workers: FakeWorker[] = [];
    const client = createConversionWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const first = client.submit(input());
    const request = workers[0].posted[0] as ConversionRasterRequestMessage;
    const foreign = await convertConversionRequestAsync({ ...request, token: { ...request.token, projectId: 'project-b', baseRevision: 8 } });
    workers[0].emit(foreign);
    workers[0].emit(await convertConversionRequestAsync(request));
    await expect(first.promise).resolves.toMatchObject({ token: request.token });

    const second = client.submit(input('second'));
    workers[0].emitTransport('error', { message: 'worker crashed' });
    await expect(second.promise).rejects.toBeInstanceOf(ConversionWorkerTransportError);
    expect(workers[0].terminated.count).toBe(1);

    const third = client.submit(input('third'));
    expect(workers).toHaveLength(2);
    third.cancel();
    await expect(third.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    client.dispose();
  });

  it('accepts worker error responses for the matching request', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input());
    const request = worker.posted[0] as ConversionRasterRequestMessage;
    const response = {
      protocol: request.protocol,
      type: 'conversion-error' as const,
      token: request.token,
      code: 'too-large',
      message: 'too large'
    } satisfies ConversionWorkerResponse;
    worker.emit(response);
    await expect(job.promise).rejects.toMatchObject({ code: 'too-large' });
    client.dispose();
  });

  it('ignores responses without a full token', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input('shared-request'));
    const request = worker.posted[0] as ConversionRasterRequestMessage;
    worker.emit({ protocol: request.protocol, type: 'conversion-error', code: 'missing-token', message: 'ignored' });
    worker.emit(await convertConversionRequestAsync(request));
    await expect(job.promise).resolves.toMatchObject({ token: request.token });
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
    const request = worker.posted[0] as ConversionRequestMessage;
    worker.emit({ protocol: request.protocol, type: 'conversion-error', token: request.token, code: 'unavailable', message: 'no OffscreenCanvas' });
    await expect(job.promise).resolves.toMatchObject({ token: request.token });
    expect(decodeCalls).toBe(1);
    client.dispose();
  });

  it('converts WebP content when the browser declares the blob as JPEG', async () => {
    const client = createConversionWorkerClient({
      useWorker: false,
      rasterOptions: {
        createImageBitmap: async () => ({ width: 1_057, height: 1_600 }),
        surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(16) }) } })
      }
    });
    const result = await client.requestImage(mislabeledWebpBlob(), { ...input(), targetWidth: 2, targetHeight: 2, requestId: 'mislabeled-webp' });
    expect(result.draft.stats.sourceWidth).toBe(1_057);
    expect(result.draft.stats.sourceHeight).toBe(1_600);
    expect(result.draft.document.width).toBe(2);
    expect(result.draft.document.height).toBe(2);
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
    const expected = await convertRasterToPatternAsync({ width: 1, height: 1, pixels }, { targetWidth: 1, targetHeight: 1, catalog: passthroughCatalog, token: result.token });
    expect(result.draft.document.kind).toEqual(expected.document.kind);
    expect(result.draft.document.colors).toEqual(expected.document.colors);
    expect(result.draft.document.catalog).toEqual(passthroughCatalog.association);
    client.dispose();
  });

  it('applies confettiDistance on the fallback image path', async () => {
    const red = [255, 0, 0, 255];
    const pixels = new Uint8ClampedArray([...red, ...red, ...red, ...red, 0, 0, 255, 255, ...red, ...red, ...red, ...red]);
    const client = createConversionWorkerClient({ useWorker: false, rasterOptions: {
      createImageBitmap: async () => ({ width: 3, height: 3 }),
      surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: pixels }) } })
    } });
    const image = new Blob([pngBytes(3, 3).buffer as ArrayBuffer], { type: 'image/png' });
    const result = await client.requestImage(image, { ...input(), targetWidth: 3, targetHeight: 3, confettiDistance: 1, requestId: 'fallback-confetti' });
    expect(result.draft.stats.paletteUsage).toEqual([{ paletteId: 1, catalogId: 'red', count: 9 }]);
    expect(result.draft.document.colors[4 * 4]).toBe(1);
    client.dispose();
  });

  it('serializes fallback rasterization and conversion to one active main-thread job', async () => {
    let active = 0;
    let maximumActive = 0;
    const create = () => createConversionWorkerClient({ useWorker: false, rasterOptions: {
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
      const job = create().submitImage(imageBlob(), { ...input(`serialized-${index}`) });
      return job.promise;
    });
    await Promise.all(jobs);
    expect(maximumActive).toBe(1);
  });

  it('tears down pending work and ignores late messages after disposal', async () => {
    const worker = new FakeWorker();
    const client = createConversionWorkerClient({ workerFactory: () => worker });
    const job = client.submit(input('dispose-pending'));
    client.dispose();
    await expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError);
    expect(worker.terminated.count).toBe(1);
    worker.emit(await convertConversionRequestAsync(worker.posted[0] as ConversionRequestMessage));
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
    client.dispose();
  });

  it('removes cancelled queued fallback jobs so the bounded queue can accept replacement work', async () => {
    let resolveBitmap!: (bitmap: { width: number; height: number; close: () => void }) => void;
    const bitmapGate = new Promise<{ width: number; height: number; close: () => void }>((resolve) => { resolveBitmap = resolve; });
    const create = () => createConversionWorkerClient({ useWorker: false, rasterOptions: {
      createImageBitmap: async () => bitmapGate,
      surfaceFactory: () => ({ context: { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } })
    } });
    const source = imageBlob();
    const first = create().submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-active' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = Array.from({ length: 32 }, (_, index) => create().submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: `queue-${index}` }));
    const busy = create().submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-busy' });
    for (const job of queued) job.cancel();
    const replacement = create().submitImage(source, { ...input(), targetWidth: 1, targetHeight: 1, requestId: 'queue-replacement' });
    await Promise.all(queued.map((job) => expect(job.promise).rejects.toBeInstanceOf(ConversionCancelledError)));
    await expect(busy.promise).rejects.toMatchObject({ code: 'main-thread-busy' });
    resolveBitmap({ width: 1, height: 1, close: () => undefined });
    await expect(first.promise).resolves.toBeTruthy();
    await expect(replacement.promise).resolves.toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import {
  CONVERSION_CANCEL_TYPE,
  CONVERSION_CANCELLED_TYPE,
  createConversionCancel,
  createConversionImageRequest,
  createConversionRequest,
  type ConversionWorkerResponse
} from '../conversion/image-to-pattern';
import { handleImageConversionWorkerMessage } from './image-conversion.worker';

const request = createConversionRequest({
  width: 1,
  height: 1,
  pixels: new Uint8ClampedArray([10, 20, 30, 255])
}, {
  targetWidth: 1,
  targetHeight: 1,
  token: { projectId: 'worker-project', baseRevision: 2, requestId: 'worker-request' }
});

function waitForTimer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
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

describe('image conversion worker handler', () => {
  it('returns a structured-clone result without transferring document arrays', async () => {
    const responses: ConversionWorkerResponse[] = [];
    const active = new Map<string, { cancelled: boolean }>();
    handleImageConversionWorkerMessage(request, (response) => responses.push(response), active);
    await waitForTimer();
    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe('conversion-result');
    if (responses[0]?.type === 'conversion-result') {
      expect(responses[0].draft.document.kind).toBeInstanceOf(Uint8Array);
      expect(responses[0].draft.document.colors).toBeInstanceOf(Uint16Array);
    }
    expect(active.size).toBe(0);
  });

  it('marks queued requests cancelled before conversion starts', async () => {
    const responses: ConversionWorkerResponse[] = [];
    const cancelled = new Map<string, { cancelled: boolean }>();
    handleImageConversionWorkerMessage(request, (response) => responses.push(response), cancelled);
    handleImageConversionWorkerMessage(createConversionCancel(request.token), (response) => responses.push(response), cancelled);
    await waitForTimer();
    expect(responses).toEqual([{ protocol: request.protocol, type: CONVERSION_CANCELLED_TYPE, token: request.token }]);
    expect(cancelled.size).toBe(0);
  });

  it('reports malformed request and cancellation protocol payloads', () => {
    const responses: ConversionWorkerResponse[] = [];
    handleImageConversionWorkerMessage({ ...request, protocol: 'wrong' }, (response) => responses.push(response));
    handleImageConversionWorkerMessage({ protocol: request.protocol, type: CONVERSION_CANCEL_TYPE }, (response) => responses.push(response));
    expect(responses).toHaveLength(2);
    expect(responses.every((response) => response.type === 'conversion-error')).toBe(true);
  });

  it('cancels while worker decode is pending and releases the decoded bitmap', async () => {
    let resolveBitmap!: (bitmap: { width: number; height: number; close: () => void }) => void;
    let closed = 0;
    const originalCreateImageBitmap = (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOffscreenCanvas = (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => new Promise((resolve) => {
      resolveBitmap = resolve as (bitmap: { width: number; height: number; close: () => void }) => void;
    });
    class FakeOffscreenCanvas {
      readonly context = {
        imageSmoothingEnabled: true,
        drawImage: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) })
      };

      getContext(): typeof this.context {
        return this.context;
      }
    }
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
    try {
      const imageRequest = createConversionImageRequest({
        source: new Blob([pngBytes(1, 1).buffer as ArrayBuffer], { type: 'image/png' }),
        targetWidth: 1,
        targetHeight: 1,
        token: { projectId: 'worker-project', baseRevision: 2, requestId: 'decode-cancel' }
      });
      const responses: ConversionWorkerResponse[] = [];
      const active = new Map<string, { cancelled: boolean }>();
      handleImageConversionWorkerMessage(imageRequest, (response) => responses.push(response), active);
      await waitForTimer();
      expect(resolveBitmap).toBeTypeOf('function');
      handleImageConversionWorkerMessage(createConversionCancel(imageRequest.token), (response) => responses.push(response), active);
      resolveBitmap({ width: 1, height: 1, close: () => { closed += 1; } });
      await waitForTimer();
      expect(responses).toEqual([{ protocol: imageRequest.protocol, type: CONVERSION_CANCELLED_TYPE, token: imageRequest.token }]);
      expect(closed).toBe(1);
      expect(active.size).toBe(0);
    } finally {
      if (originalCreateImageBitmap === undefined) delete (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
      else (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = originalCreateImageBitmap;
      if (originalOffscreenCanvas === undefined) delete (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = originalOffscreenCanvas;
    }
  });

  it('isolates active work by the complete token rather than request ID alone', async () => {
    const first = createConversionRequest({ width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }, {
      targetWidth: 1,
      targetHeight: 1,
      token: { projectId: 'first-project', baseRevision: 1, requestId: 'reused' }
    });
    const second = createConversionRequest({ width: 1, height: 1, pixels: new Uint8ClampedArray([4, 5, 6, 255]) }, {
      targetWidth: 1,
      targetHeight: 1,
      token: { projectId: 'second-project', baseRevision: 2, requestId: 'reused' }
    });
    const responses: ConversionWorkerResponse[] = [];
    const active = new Map<string, { cancelled: boolean }>();
    handleImageConversionWorkerMessage(first, (response) => responses.push(response), active);
    handleImageConversionWorkerMessage(second, (response) => responses.push(response), active);
    await waitForTimer();
    expect(responses.map((response) => response.token?.projectId)).toEqual(['first-project', 'second-project']);
    expect(active.size).toBe(0);
  });

  it('forwards autoCrop from an image request and trims empty pattern borders', async () => {
    const originalCreateImageBitmap = (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
    const originalOffscreenCanvas = (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({ width: 4, height: 2, close: () => undefined });
    class FakeOffscreenCanvas {
      readonly context = {
        imageSmoothingEnabled: true,
        drawImage: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0
        ]) })
      };

      getContext(): typeof this.context {
        return this.context;
      }
    }
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
    try {
      const imageRequest = createConversionImageRequest({
        source: new Blob([pngBytes(4, 2).buffer as ArrayBuffer], { type: 'image/png' }),
        targetWidth: 4,
        targetHeight: 2,
        autoCrop: true,
        token: { projectId: 'worker-project', baseRevision: 2, requestId: 'worker-autocrop' }
      });
      expect(imageRequest.autoCrop).toBe(true);
      const responses: ConversionWorkerResponse[] = [];
      const active = new Map<string, { cancelled: boolean }>();
      handleImageConversionWorkerMessage(imageRequest, (response) => responses.push(response), active);
      await waitForTimer();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.type).toBe('conversion-result');
      if (responses[0]?.type === 'conversion-result') {
        // Source dims stay original (4x2 decode); the pattern trims to the
        // stitched 2x1 content box.
        expect(responses[0].draft.stats.sourceWidth).toBe(4);
        expect(responses[0].draft.stats.sourceHeight).toBe(2);
        expect(responses[0].draft.document.width).toBe(2);
        expect(responses[0].draft.document.height).toBe(1);
      }
      expect(active.size).toBe(0);
    } finally {
      if (originalCreateImageBitmap === undefined) delete (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
      else (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = originalCreateImageBitmap;
      if (originalOffscreenCanvas === undefined) delete (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
      else (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = originalOffscreenCanvas;
    }
  });
});

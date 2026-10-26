import { describe, expect, it } from 'vitest';
import { preScaleSource, type ReadableSurface } from './surface';

/** Fake sized surfaces that record each draw and whether they were released. */
function surfaceHarness() {
  const created: { width: number; height: number; freed: boolean }[] = [];
  const draws: { source: unknown; destinationRect: number[]; smoothing: boolean | undefined; quality: string | undefined }[] = [];
  const factory = (width: number, height: number): ReadableSurface => {
    const canvas = { width, height, freed: false };
    created.push(canvas);
    const context = {
      drawImage: (...args: unknown[]) => {
        draws.push({ source: args[0], destinationRect: args.slice(5, 9) as number[], smoothing: context.imageSmoothingEnabled, quality: context.imageSmoothingQuality });
      },
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      imageSmoothingEnabled: undefined as boolean | undefined,
      imageSmoothingQuality: undefined as string | undefined
    };
    return { canvas, context, dispose: () => { canvas.freed = true; } };
  };
  return { factory, draws, created };
}

describe('preScaleSource', () => {
  it('halves only until a final draw fits within 2x, then draws to the exact fitted size', () => {
    const harness = surfaceHarness();
    const original = { kind: 'bitmap' };
    const prepared = preScaleSource(original, 20_000, 10_000, 4_096, 2_048, harness.factory);
    // 20000x10000 -> 10000x5000 -> 5000x2500, then 5000x2500 -> 4096x2048.
    expect(harness.draws.map((draw) => draw.destinationRect)).toEqual([
      [0, 0, 10_000, 5_000],
      [0, 0, 5_000, 2_500],
      [0, 0, 4_096, 2_048]
    ]);
    expect(harness.draws[0]?.source).toBe(original);
    expect(harness.draws[1]?.source).toBe(harness.created[0]);
    expect(harness.draws[2]?.source).toBe(harness.created[1]);
    expect(harness.draws.every((draw) => draw.smoothing === true && draw.quality === 'high')).toBe(true);
    expect(prepared?.source).toBe(harness.created[2]);
    expect(prepared?.width).toBe(4_096);
    expect(prepared?.height).toBe(2_048);
    prepared?.dispose();
    expect(harness.created.every((canvas) => canvas.freed && canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('returns undefined and releases earlier surfaces when a surface cannot be allocated', () => {
    const harness = surfaceHarness();
    const factory = (width: number, height: number): ReadableSurface | undefined => width === 5_000 ? undefined : harness.factory(width, height);
    expect(preScaleSource({ kind: 'bitmap' }, 20_000, 10_000, 4_096, 2_048, factory)).toBeUndefined();
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.freed).toBe(true);
  });

  it('releases created surfaces when a later step throws', () => {
    const harness = surfaceHarness();
    let created = 0;
    const factory = (width: number, height: number): ReadableSurface => {
      created += 1;
      if (created >= 2) throw new Error('allocation failed');
      return harness.factory(width, height);
    };
    expect(() => preScaleSource({ kind: 'bitmap' }, 20_000, 10_000, 4_096, 2_048, factory)).toThrow('allocation failed');
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.freed).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from './motion';

afterEach(() => { vi.unstubAllGlobals(); });

describe('prefersReducedMotion', () => {
  it('reflects the media query', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is false when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', () => { throw new Error('unsupported'); });
    expect(prefersReducedMotion()).toBe(false);
  });
});

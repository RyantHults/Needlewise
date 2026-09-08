import { describe, expect, it } from 'vitest';
import { PALETTE_SYMBOLS } from '../domain';
import { SYMBOL_RENDER_OVERRIDES } from './symbol-font';

describe('symbol render overrides contract', () => {
  const pool = new Set(PALETTE_SYMBOLS);

  it('keeps the override table small and keyed to real pool glyphs', () => {
    const keys = Object.keys(SYMBOL_RENDER_OVERRIDES);
    expect(keys.length).toBeGreaterThan(0);
    // Guardrail: exceptions stay enumerable, so the table never silently grows.
    expect(keys.length).toBeLessThanOrEqual(20);
    for (const glyph of keys) {
      expect(pool.has(glyph), `override key ${glyph} not present in PALETTE_SYMBOLS`).toBe(true);
    }
  });

  it('bounds every dy to a finite offset within half a default cell', () => {
    for (const [glyph, override] of Object.entries(SYMBOL_RENDER_OVERRIDES)) {
      if (override.dy === undefined) continue;
      expect(Number.isFinite(override.dy), `${glyph} dy must be finite`).toBe(true);
      expect(Math.abs(override.dy), `${glyph} dy must stay within 16px`).toBeLessThanOrEqual(16);
    }
  });

  it('bounds every scale to a positive shrink-or-grow inside (0.1, 2]', () => {
    for (const [glyph, override] of Object.entries(SYMBOL_RENDER_OVERRIDES)) {
      if (override.scale === undefined) continue;
      expect(Number.isFinite(override.scale), `${glyph} scale must be finite`).toBe(true);
      expect(override.scale, `${glyph} scale must stay above 0.1`).toBeGreaterThan(0.1);
      expect(override.scale, `${glyph} scale must stay at or below 2`).toBeLessThanOrEqual(2);
    }
  });
});
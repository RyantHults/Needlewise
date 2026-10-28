import { describe, expect, it } from 'vitest';
import { anchoredPosition } from './anchored-position';

const viewport = { width: 1000, height: 800 };

describe('anchoredPosition', () => {
  it('places a right menu beside the anchor', () => {
    expect(anchoredPosition({ left: 10, right: 50, top: 100, bottom: 130 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 56, top: 100 });
  });

  it('clamps a right menu inside the viewport on both axes', () => {
    expect(anchoredPosition({ left: 900, right: 990, top: 790, bottom: 820 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 812, top: 642 });
    expect(anchoredPosition({ left: -50, right: -40, top: -20, bottom: 10 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 8, top: 8 });
  });

  it('places an above menu over the anchor and translates it up', () => {
    expect(anchoredPosition({ left: 100, right: 140, top: 300, bottom: 330 }, 'above', { width: 240, height: 0 }, viewport))
      .toEqual({ left: 100, top: 292, transform: 'translateY(-100%)' });
  });

  it('clamps an above menu horizontally and keeps its top on screen', () => {
    expect(anchoredPosition({ left: 900, right: 940, top: 2, bottom: 32 }, 'above', { width: 240, height: 0 }, viewport))
      .toEqual({ left: 760, top: 8, transform: 'translateY(-100%)' });
  });

  it('places a below menu under the anchor, left-aligned and clamped', () => {
    expect(anchoredPosition({ left: 100, right: 140, top: 300, bottom: 330 }, 'below', { width: 240, height: 300 }, viewport))
      .toEqual({ left: 100, top: 336 });
    expect(anchoredPosition({ left: 900, right: 940, top: 300, bottom: 330 }, 'below', { width: 240, height: 300 }, viewport))
      .toEqual({ left: 760, top: 336 });
  });

  it('flips a below menu above the anchor when only that side fits', () => {
    expect(anchoredPosition({ left: 100, right: 140, top: 600, bottom: 630 }, 'below', { width: 240, height: 300 }, viewport))
      .toEqual({ left: 100, top: 292 });
  });

  it('keeps a below menu on screen when neither side fits', () => {
    const short = { width: 1000, height: 399 };
    expect(anchoredPosition({ left: 100, right: 140, top: 100, bottom: 130 }, 'below', { width: 240, height: 340 }, short))
      .toEqual({ left: 100, top: 59 });
    expect(anchoredPosition({ left: 100, right: 140, top: 260, bottom: 290 }, 'below', { width: 240, height: 340 }, short))
      .toEqual({ left: 100, top: 8 });
  });
});

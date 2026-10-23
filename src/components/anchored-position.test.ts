import { describe, expect, it } from 'vitest';
import { anchoredPosition } from './anchored-position';

const viewport = { width: 1000, height: 800 };

describe('anchoredPosition', () => {
  it('places a right menu beside the anchor', () => {
    expect(anchoredPosition({ left: 10, right: 50, top: 100 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 56, top: 100 });
  });

  it('clamps a right menu inside the viewport on both axes', () => {
    expect(anchoredPosition({ left: 900, right: 990, top: 790 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 812, top: 642 });
    expect(anchoredPosition({ left: -50, right: -40, top: -20 }, 'right', { width: 188, height: 158 }, viewport))
      .toEqual({ left: 8, top: 8 });
  });

  it('places an above menu over the anchor and translates it up', () => {
    expect(anchoredPosition({ left: 100, right: 140, top: 300 }, 'above', { width: 240, height: 0 }, viewport))
      .toEqual({ left: 100, top: 292, transform: 'translateY(-100%)' });
  });

  it('clamps an above menu horizontally and keeps its top on screen', () => {
    expect(anchoredPosition({ left: 900, right: 940, top: 2 }, 'above', { width: 240, height: 0 }, viewport))
      .toEqual({ left: 760, top: 8, transform: 'translateY(-100%)' });
  });
});

import { describe, expect, it } from 'vitest';
import { catalogReference, nearestDmcColor } from './trace-tools';

describe('trace colour tools', () => {
  it('maps a sampled RGB value to the nearest offline catalog colour', () => {
    const color = nearestDmcColor({ r: 0, g: 0, b: 0 });
    expect(color.hex).toBe('#000000');
    expect(catalogReference(color)).toMatchObject({ catalogId: 'dmc-compatible-screen-approximation', sourceId: color.sourceId, code: color.code });
  });
});

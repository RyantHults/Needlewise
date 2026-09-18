import { applyCommand, createDocument, QuarterCorner } from '../domain';
import { describe, expect, it } from 'vitest';
import {
  deriveProjectThumbnail,
  completeProjectSummary,
  PROJECT_THUMBNAIL_FABRIC_COLOR,
  PROJECT_THUMBNAIL_MAX_AXIS,
  PROJECT_THUMBNAIL_MAX_CELLS,
  sanitizeProjectMetadata,
  sanitizeProjectThumbnail
} from './project-thumbnail';

describe('project thumbnail summaries', () => {
  it('samples destination-cell centres and uses the first occupied slot', () => {
    let document = createDocument({
      width: 256,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    document = applyCommand(document, { type: 'set-full', x: 1, y: 0, color: 1 }).document;
    document = applyCommand(document, { type: 'set-full', x: 3, y: 0, color: 2 }).document;
    const thumbnail = deriveProjectThumbnail(document);

    expect(thumbnail.columns).toBe(128);
    expect(thumbnail.rows).toBe(1);
    expect(thumbnail.indices.slice(0, 2)).toEqual([1, 2]);
    expect(thumbnail.indices).toHaveLength(128);

    let malformedPalette = createDocument({
      width: 1,
      height: 1,
      palette: [
        { id: 1, name: 'Malformed', color: 'not-a-css-color' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    malformedPalette = applyCommand(malformedPalette, { type: 'set-quarter', x: 0, y: 0, corner: QuarterCorner.NW, color: 1 }).document;
    malformedPalette = applyCommand(malformedPalette, { type: 'set-quarter', x: 0, y: 0, corner: QuarterCorner.NE, color: 2 }).document;
    expect(deriveProjectThumbnail(malformedPalette).palette).toEqual([PROJECT_THUMBNAIL_FABRIC_COLOR]);
    expect(deriveProjectThumbnail(malformedPalette).indices).toEqual([0]);
  });

  it('does not upscale and bounds both thumbnail axes', () => {
    const small = deriveProjectThumbnail(createDocument({ width: 2, height: 3 }));
    expect(small).toMatchObject({ columns: 2, rows: 3 });
    expect(small.indices).toHaveLength(6);

    // Derivation is deliberately bounded to sampled cell colors and palette
    // lookup; unrelated document invariants are validated at their own
    // persistence boundary.
    const unvalidated = createDocument({ width: 1, height: 1 });
    unvalidated.backstitches.ids = new Uint32Array([1]);
    expect(deriveProjectThumbnail(unvalidated).indices).toEqual([0]);

    const large = deriveProjectThumbnail(createDocument({ width: 256, height: 192 }));
    expect(large.columns).toBe(PROJECT_THUMBNAIL_MAX_AXIS);
    expect(large.rows).toBe(96);
    expect(large.indices).toHaveLength(128 * 96);
  });

  it('normalizes safe cache values and rejects unbounded or non-plain arrays', () => {
    const normalized = sanitizeProjectThumbnail({
      version: 1,
      revision: 3,
      columns: 1,
      rows: 1,
      palette: ['#F3EEE5', '#D33'],
      indices: [1]
    }, 3);
    expect(normalized).toMatchObject({ palette: ['#f3eee5', '#dd3333'], indices: [1] });
    if (normalized === undefined) throw new Error('expected normalized thumbnail');

    expect(sanitizeProjectThumbnail({
      version: 1,
      revision: 3,
      columns: 1,
      rows: 1,
      palette: new Uint8Array([1, 2, 3]),
      indices: [0]
    }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({
      version: 1,
      revision: 3,
      columns: PROJECT_THUMBNAIL_MAX_AXIS + 1,
      rows: 1,
      palette: [PROJECT_THUMBNAIL_FABRIC_COLOR],
      indices: []
    }, 3)).toBeUndefined();
    const maxBound = sanitizeProjectThumbnail({
      version: 1,
      revision: 3,
      columns: PROJECT_THUMBNAIL_MAX_AXIS,
      rows: PROJECT_THUMBNAIL_MAX_AXIS,
      palette: [PROJECT_THUMBNAIL_FABRIC_COLOR],
      indices: new Array(PROJECT_THUMBNAIL_MAX_CELLS).fill(0)
    }, 3);
    expect(maxBound?.indices).toHaveLength(PROJECT_THUMBNAIL_MAX_CELLS);

    const metadata = {
      id: 'safe-cache', title: 'Safe', notes: '', createdAt: 1, updatedAt: 1, revision: 3,
      width: 2,
      height: 2,
      thumbnail: normalized
    };
    const safe = sanitizeProjectMetadata(metadata);
    const sourceThumbnail = metadata.thumbnail;
    expect(safe.thumbnail).not.toBe(sourceThumbnail);
    expect(safe.thumbnail?.palette).not.toBe(sourceThumbnail.palette);
    expect(safe.thumbnail?.indices).not.toBe(sourceThumbnail.indices);
    sourceThumbnail.palette[1] = '#000000';
    expect(safe.thumbnail?.palette[1]).toBe('#dd3333');
  });

  it('sanitizes dimensions as a bounded all-or-nothing pair', () => {
    const thumbnail = sanitizeProjectThumbnail({
      version: 1,
      revision: 3,
      columns: 1,
      rows: 1,
      palette: [PROJECT_THUMBNAIL_FABRIC_COLOR],
      indices: [0]
    }, 3);
    if (thumbnail === undefined) throw new Error('expected valid thumbnail');
    const base = {
      id: 'dimensions', title: 'Dimensions', notes: '', createdAt: 1, updatedAt: 1, revision: 3,
      width: 1000, height: 1000, thumbnail
    };
    expect(completeProjectSummary(base)).toMatchObject({ width: 1000, height: 1000 });

    const malformed = [
      { ...base, width: undefined },
      { ...base, height: undefined },
      { ...base, width: 0 },
      { ...base, height: 0 },
      { ...base, width: 1.5 },
      { ...base, height: 1.5 },
      { ...base, width: 1001, height: 1000 },
      { ...base, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }
    ];
    for (const candidate of malformed) {
      expect(completeProjectSummary(candidate)).toBeUndefined();
      const safe = sanitizeProjectMetadata(candidate);
      expect(safe).not.toHaveProperty('width');
      expect(safe).not.toHaveProperty('height');
      expect(safe).not.toHaveProperty('thumbnail');
    }
  });
});

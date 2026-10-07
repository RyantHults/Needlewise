import { applyCommand, CellKind, createDocument, LayerType, layeredFromSurface, QuarterCorner, type StitchLayer } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { describe, expect, it } from 'vitest';
import {
  deriveProjectSummary,
  deriveProjectThumbnail,
  projectThumbnailsEqual,
  expectedThumbnailDimensions,
  completeProjectSummary,
  PROJECT_THUMBNAIL_FABRIC_COLOR,
  PROJECT_THUMBNAIL_MAX_AXIS,
  PROJECT_THUMBNAIL_MAX_CELLS,
  PROJECT_THUMBNAIL_OFF_CANVAS_COLOR,
  sanitizeProjectMetadata,
  sanitizeProjectThumbnail
} from './project-thumbnail';

describe('project thumbnail summaries', () => {
  it('uses the document background for empty thumbnail cells and preserves it when sanitizing', () => {
    const document = createDocument({
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 2,
      height: 1,
      settings: { backgroundColor: '#123456' }
    });
    const thumbnail = deriveProjectThumbnail(document);

    expect(thumbnail.palette).toEqual(['#123456']);
    expect(Array.from(thumbnail.indices)).toEqual([0, 0]);
    expect(sanitizeProjectThumbnail(thumbnail, document.revision)).toEqual(thumbnail);
  });

  it('samples holes of a masked canvas as the off-canvas color', () => {
    const document = createDocument({
      catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 3,
      height: 1,
      settings: { backgroundColor: '#123456' }
    });
    const thumbnail = deriveProjectThumbnail({ ...document, canvasMask: new Uint8Array([1, 0, 1]) });

    expect(thumbnail.palette).toEqual(['#123456', PROJECT_THUMBNAIL_OFF_CANVAS_COLOR]);
    expect(Array.from(thumbnail.indices)).toEqual([0, 1, 0]);
    expect(sanitizeProjectThumbnail(thumbnail, document.revision)).toEqual(thumbnail);
  });

  it('samples destination-cell centres and uses the first occupied slot', () => {
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 1024,
      height: 1,
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    document = applyCommand(document, { type: 'set-full', x: 1, y: 0, color: 1 }).document;
    document = applyCommand(document, { type: 'set-full', x: 3, y: 0, color: 2 }).document;
    const thumbnail = deriveProjectThumbnail(document);

    expect(thumbnail.columns).toBe(512);
    expect(thumbnail.rows).toBe(1);
    expect(Array.from(thumbnail.indices.slice(0, 2))).toEqual([1, 2]);
    expect(thumbnail.indices).toHaveLength(512);

    let malformedPalette = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
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
    expect(Array.from(deriveProjectThumbnail(malformedPalette).indices)).toEqual([0]);
  });

  it('does not upscale and bounds both thumbnail axes', () => {
    const small = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 3 }));
    expect(small).toMatchObject({ columns: 2, rows: 3 });
    expect(small.indices).toHaveLength(6);

    // Derivation is deliberately bounded to sampled cell colors and palette
    // lookup; unrelated document invariants are validated at their own
    // persistence boundary.
    const unvalidated = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1 });
    unvalidated.backstitches.ids = new Uint32Array([1]);
    expect(Array.from(deriveProjectThumbnail(unvalidated).indices)).toEqual([0]);

    const large = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1024, height: 768 }));
    expect(large.columns).toBe(PROJECT_THUMBNAIL_MAX_AXIS);
    expect(large.rows).toBe(384);
    expect(large.indices).toHaveLength(512 * 384);
  });

  it('samples every stitch of a pattern within the cap, and rounds the downsampled axis beyond it', () => {
    const exact = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 300, height: 200 }));
    expect(exact).toMatchObject({ columns: 300, rows: 200 });
    expect(exact.indices).toHaveLength(300 * 200);

    const wide = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1000, height: 800 }));
    expect(wide).toMatchObject({ columns: 512, rows: 410 });
  });

  it('exposes the dimensions derivation produces', () => {
    for (const [width, height] of [[1, 1], [300, 200], [512, 512], [1000, 800], [37, 1500]] as const) {
      const thumbnail = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width, height }));
      expect(expectedThumbnailDimensions(width, height)).toEqual({ columns: thumbnail.columns, rows: thumbnail.rows });
    }
  });

  it('still accepts a stored thumbnail from the former 128-axis cap', () => {
    const legacy = {
      version: 1,
      revision: 3,
      columns: 128,
      rows: 96,
      palette: [PROJECT_THUMBNAIL_FABRIC_COLOR],
      indices: new Array(128 * 96).fill(0)
    };
    expect(sanitizeProjectThumbnail(legacy, 3)).toEqual({ ...legacy, version: 2, indices: new Uint8Array(128 * 96) });
  });

  it('stores indices as a Uint8Array for small palettes and a Uint16Array beyond 256 colors', () => {
    const small = deriveProjectThumbnail(createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 2 }));
    expect(small.version).toBe(2);
    expect(small.indices).toBeInstanceOf(Uint8Array);

    const palette = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `C${i}`, color: `#${(i + 1).toString(16).padStart(6, '0')}` }));
    let document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 300, height: 1, palette });
    for (let x = 0; x < 300; x += 1) document = applyCommand(document, { type: 'set-full', x, y: 0, color: x + 1 }).document;
    const wide = deriveProjectThumbnail(document);
    expect(wide.palette.length).toBe(301);
    expect(wide.indices).toBeInstanceOf(Uint16Array);
    expect(wide.indices[299]).toBe(300);
    expect(sanitizeProjectThumbnail(wide, document.revision)).toEqual(wide);
  });

  it('converts a v1 number-array thumbnail to v2 with identical values', () => {
    const v1 = { version: 1, revision: 3, columns: 2, rows: 1, palette: ['#f3eee5', '#dd3333'], indices: [1, 0] };
    const v2 = sanitizeProjectThumbnail(v1, 3);
    expect(v2?.version).toBe(2);
    expect(v2?.indices).toBeInstanceOf(Uint8Array);
    expect(Array.from(v2?.indices ?? [])).toEqual([1, 0]);
  });

  it('rejects v2 indices with the wrong width, kind, length, or range', () => {
    const base = { version: 2, revision: 3, columns: 2, rows: 1, palette: ['#f3eee5', '#dd3333'] };
    expect(sanitizeProjectThumbnail({ ...base, indices: new Uint8Array([1, 0]) }, 3)).toBeDefined();
    expect(sanitizeProjectThumbnail({ ...base, indices: new Uint16Array([1, 0]) }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({ ...base, indices: new Int8Array([1, 0]) }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({ ...base, indices: [1, 0] }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({ ...base, indices: new Uint8Array([1]) }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({ ...base, indices: new Uint8Array([2, 0]) }, 3)).toBeUndefined();

    const widePalette = Array.from({ length: 257 }, () => '#123456');
    expect(sanitizeProjectThumbnail({ ...base, palette: widePalette, indices: new Uint8Array([1, 0]) }, 3)).toBeUndefined();
    expect(sanitizeProjectThumbnail({ ...base, palette: widePalette, indices: new Uint16Array([256, 0]) }, 3)).toBeDefined();
  });

  it('compares thumbnails field-wise and element-wise, and clones independently', () => {
    const document = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 2, height: 1 });
    const a = deriveProjectThumbnail(document);
    const b = deriveProjectThumbnail(document);
    expect(projectThumbnailsEqual(a, b)).toBe(true);
    expect(projectThumbnailsEqual(a, undefined)).toBe(false);
    expect(projectThumbnailsEqual(a, { ...b, indices: Uint8Array.from([0, 1]) })).toBe(false);
    expect(projectThumbnailsEqual(a, { ...b, palette: ['#000000'] })).toBe(false);
    expect(projectThumbnailsEqual(a, { ...b, revision: b.revision + 1 })).toBe(false);

    const metadata = { id: 'c', title: 'C', notes: '', createdAt: 1, updatedAt: 1, revision: a.revision, width: 2, height: 1, thumbnail: a };
    const cloned = sanitizeProjectMetadata(metadata).thumbnail;
    a.indices[0] = 0;
    expect(cloned?.indices).not.toBe(a.indices);
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
    expect(normalized).toMatchObject({ version: 2, palette: ['#f3eee5', '#dd3333'], indices: new Uint8Array([1]) });
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
      version: 2,
      revision: 3,
      columns: PROJECT_THUMBNAIL_MAX_AXIS,
      rows: PROJECT_THUMBNAIL_MAX_AXIS,
      palette: [PROJECT_THUMBNAIL_FABRIC_COLOR],
      indices: new Uint8Array(PROJECT_THUMBNAIL_MAX_CELLS)
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

  it('flattens layered documents and ignores hidden layers', () => {
    let surface = createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association,
      width: 2,
      height: 1,
      settings: { backgroundColor: '#123456' },
      palette: [
        { id: 1, name: 'Red', color: '#d33' },
        { id: 2, name: 'Blue', color: '#36c' }
      ]
    });
    surface = applyCommand(surface, { type: 'set-full', x: 0, y: 0, color: 1 }).document;
    const document = layeredFromSurface(surface);
    const top: StitchLayer = { id: 3, type: LayerType.Stitch, name: 'Top', visible: true, kind: new Uint8Array(2), colors: new Uint16Array(8), completed: new Uint8Array(2) };
    top.kind[0] = CellKind.Full;
    top.colors[0] = 2;
    top.kind[1] = CellKind.Full;
    top.colors[4] = 2;
    document.layers.splice(1, 0, top);
    document.nextLayerId = 4;

    expect(Array.from(deriveProjectThumbnail(document).indices)).toEqual([1, 1]);
    expect(deriveProjectThumbnail(document).palette).toEqual(['#123456', '#3366cc']);

    top.visible = false;
    const hidden = deriveProjectSummary(document);
    expect(hidden).toMatchObject({ width: 2, height: 1 });
    expect(hidden.thumbnail.palette).toEqual(['#123456', '#dd3333']);
    expect(Array.from(hidden.thumbnail.indices)).toEqual([1, 0]);
  });
});

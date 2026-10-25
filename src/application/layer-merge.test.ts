import { describe, expect, it } from 'vitest';
import { applyLayerStructureCommand, layerAddCommand, layerSetVisibilityCommand, LayerType, type LayeredDocument } from '../domain';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { planLayerMerge } from './layer-merge';
import { createLayeredDocument } from '../domain/test-fixtures';

/** Bottom to top: Stitches (1), Stitches 2 (3), Stitches 3 (4), Specialty (2). */
function document(): LayeredDocument {
  const doc = createLayeredDocument({ width: 4, height: 4, catalog: DEFAULT_CATALOG_DEFINITION.association, palette: [{ id: 1, name: 'Red', color: '#d33' }] });
  applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch, { id: 3 }));
  applyLayerStructureCommand(doc, layerAddCommand(LayerType.Stitch, { id: 4 }));
  return doc;
}

const hide = (doc: LayeredDocument, id: number) => applyLayerStructureCommand(doc, layerSetVisibilityCommand(id, false));
const select = (primary: number | 'canvas' | 'reference', layerIds: number[]) => ({ primary, layerIds });

describe('planLayerMerge', () => {
  it('has no plan for Canvas or Reference', () => {
    expect(planLayerMerge(document(), select('canvas', []))).toBeNull();
    expect(planLayerMerge(document(), select('reference', []))).toBeNull();
  });

  it('merges several layers into the bottom-most, bottom to top', () => {
    expect(planLayerMerge(document(), select(4, [1, 3, 4]))).toMatchObject({ targetId: 1, sourceIds: [3, 4] });
  });

  it('refuses mixed types and hidden selected layers', () => {
    expect(planLayerMerge(document(), select(2, [1, 2]))).toEqual({ disabledReason: 'Select only stitch layers or only specialty layers to merge them.' });
    const doc = document();
    hide(doc, 3);
    expect(planLayerMerge(doc, select(4, [3, 4]))).toEqual({ disabledReason: 'Show every selected layer to merge them.' });
  });

  it('merges one layer down into the layer below', () => {
    expect(planLayerMerge(document(), select(4, [4]))).toMatchObject({ targetId: 3, sourceIds: [4] });
  });

  it('refuses merge down at the bottom of a group, onto a hidden layer, and from a hidden layer', () => {
    const doc = document();
    expect(planLayerMerge(doc, select(1, [1]))).toEqual({ disabledReason: 'There is no stitch layer below to merge into.' });
    expect(planLayerMerge(doc, select(2, [2]))).toEqual({ disabledReason: 'There is no specialty layer below to merge into.' });
    hide(doc, 3);
    expect(planLayerMerge(doc, select(4, [4]))).toEqual({ disabledReason: 'Show Stitches 2 to merge into it.' });
    expect(planLayerMerge(doc, select(3, [3]))).toEqual({ disabledReason: 'Show this layer to merge it.' });
  });
});

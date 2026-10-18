import { type Layer, type LayeredDocument } from '../domain';
import type { LayerSelection } from './types';

export type LayerMergePlan =
  | { readonly targetId: number; readonly sourceIds: readonly number[]; readonly title: string }
  | { readonly disabledReason: string };

const TYPE_NOUN: Record<Layer['type'], string> = { stitch: 'stitch', specialty: 'specialty' };

/**
 * What the Merge button does for the layer selection. Several layers merge into
 * the bottom-most one, bottom to top, so the topmost wins cell conflicts; one
 * layer merges down into the layer directly below. Null for Canvas and Reference.
 */
export function planLayerMerge(document: LayeredDocument, selection: LayerSelection): LayerMergePlan | null {
  const ids = selection.layerIds;
  if (typeof selection.primary !== 'number' || ids.length === 0) return null;
  const layers = ids.map((id) => document.layers.find((layer) => layer.id === id));
  if (layers.some((layer) => layer === undefined)) return null;
  const selected = layers as Layer[];
  if (selected.length > 1) {
    if (selected.some((layer) => layer.type !== selected[0]?.type)) return { disabledReason: 'Select only stitch layers or only specialty layers to merge them.' };
    if (selected.some((layer) => !layer.visible)) return { disabledReason: 'Show every selected layer to merge them.' };
    const [target, ...sources] = selected as [Layer, ...Layer[]];
    return { targetId: target.id, sourceIds: sources.map((layer) => layer.id), title: `Merge ${String(selected.length)} layers into ${target.name}` };
  }
  const layer = selected[0] as Layer;
  if (!layer.visible) return { disabledReason: 'Show this layer to merge it.' };
  const index = document.layers.findIndex((other) => other.id === layer.id);
  const below = index > 0 ? document.layers[index - 1] : undefined;
  if (below === undefined || below.type !== layer.type) return { disabledReason: `There is no ${TYPE_NOUN[layer.type]} layer below to merge into.` };
  if (!below.visible) return { disabledReason: `Show ${below.name} to merge into it.` };
  return { targetId: below.id, sourceIds: [layer.id], title: `Merge ${layer.name} into ${below.name}` };
}

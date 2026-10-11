import { CellKind, LayerType, type LayeredDocument, type PatternDocument, type SpecialtyLayer } from './types';
import type { PackedBackstitchCompletionDelta, PackedCellCompletionDelta } from './commands';
import { isThreeQuarterPairKind } from './model';

export type ProgressOperation = 'toggle' | 'set' | 'clear';

/** A Track mark in composite space: indices, component masks and backstitch ids as the flattened view shows them. */
export interface ProgressCommand {
  readonly cells?: { readonly indices: Uint32Array; readonly masks: Uint8Array };
  readonly backstitchIds?: Uint32Array;
  readonly operation: ProgressOperation;
  readonly expectedRevision?: number;
}

/** One layer's share of a mark, as absolute before/after completion values. */
export interface ProgressEntryPart {
  readonly layerId: number;
  readonly cells?: PackedCellCompletionDelta;
  readonly backstitches?: PackedBackstitchCompletionDelta;
}

/** One Track undo step: the per-layer completion deltas a mark wrote. */
export interface ProgressEntry {
  readonly parts: readonly ProgressEntryPart[];
}

/** The topmost visible stitch layer with a non-empty cell at `index`, which supplies that composite cell. */
export function coveringLayerId(document: LayeredDocument, index: number): number | null {
  for (let layerIndex = document.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = document.layers[layerIndex];
    if (layer.type === LayerType.Stitch && layer.visible && layer.kind[index] !== CellKind.Empty) return layer.id;
  }
  return null;
}

/**
 * The visible specialty layer holding backstitch `id`, or null when no visible
 * layer holds it or a higher visible layer covers the same segment, so the
 * composite does not show it.
 */
export function coveringBackstitchLayerId(document: LayeredDocument, id: number): number | null {
  const layers = document.layers.filter((layer): layer is SpecialtyLayer => layer.type === LayerType.Specialty && layer.visible);
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const store = layers[layerIndex].backstitches;
    const position = store.ids.indexOf(id);
    if (position < 0) continue;
    for (const upper of layers.slice(layerIndex + 1)) {
      const lines = upper.backstitches;
      for (let index = 0; index < lines.ids.length; index += 1) {
        if (lines.x1[index] === store.x1[position] && lines.y1[index] === store.y1[position] && lines.x2[index] === store.x2[position] && lines.y2[index] === store.y2[position]) return null;
      }
    }
    return layers[layerIndex].id;
  }
  return null;
}

/**
 * The completion components of a composite cell: bits 0–3 for the colored
 * slots of quarter and three-quarter-pair cells, bit 0 for any other stitch.
 * A `paletteId` keeps only the components of that color; null keeps all.
 */
export function colorComponentMask(composite: PatternDocument, index: number, paletteId: number | null): number {
  const kind = composite.kind[index];
  if (kind === CellKind.Empty) return 0;
  const offset = index * 4;
  if (kind === CellKind.Quarters || isThreeQuarterPairKind(kind)) {
    let mask = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const color = composite.colors[offset + slot];
      if (color !== 0 && (paletteId === null || color === paletteId)) mask |= 1 << slot;
    }
    return mask;
  }
  return paletteId === null || composite.colors[offset] === paletteId ? 1 : 0;
}

import { CellKind, LayerType, type LayeredDocument, type PatternDocument, type ProgressChangeSet } from './types';
import type { PackedBackstitchCompletionDelta, PackedCellCompletionDelta } from './commands';
import { componentSlotMask } from './cell-components';

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

export function emptyProgress(): ProgressChangeSet {
  return { cellIndices: new Uint32Array(0), backstitchIds: new Uint32Array(0), marked: 0, unmarked: 0 };
}

/** A detached copy; a missing change set is empty. */
export function cloneProgress(progress: ProgressChangeSet | undefined): ProgressChangeSet {
  return progress === undefined
    ? emptyProgress()
    : { cellIndices: progress.cellIndices.slice(), backstitchIds: progress.backstitchIds.slice(), marked: progress.marked, unmarked: progress.unmarked };
}

/** The components marked and unmarked when a completed-component count moves from `before` to `after`. */
export function progressActivity(before: number, after: number): Pick<ProgressChangeSet, 'marked' | 'unmarked'> {
  return { marked: Math.max(0, after - before), unmarked: Math.max(0, before - after) };
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
 * The completion components of a composite cell: bits 0–3 for the colored
 * slots of quarter and three-quarter-pair cells, bit 0 for any other stitch.
 * A `paletteId` keeps only the components of that color; null keeps all.
 */
export function colorComponentMask(composite: PatternDocument, index: number, paletteId: number | null): number {
  const offset = index * 4;
  const mask = componentSlotMask(composite.kind[index], composite.colors, offset);
  if (paletteId === null) return mask;
  let kept = 0;
  for (let slot = 0; slot < 4; slot += 1) if ((mask & (1 << slot)) !== 0 && composite.colors[offset + slot] === paletteId) kept |= 1 << slot;
  return kept;
}

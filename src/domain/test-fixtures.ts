// Fixtures for domain tests. Marks are Track progress, not editor edits, so
// these write `completed` on a copy instead of going through a command or a
// history. Editors start from `layeredFromSurface`'s two default layers.
import { backstitchStoresEqual, readBackstitch } from './backstitch-store';
import { applyCommandsToDraft, commandRequiresSnapshot, MutationTracker } from './commands';
import { palettesEqual, settingsEqual, typedArraysEqual } from './equality';
import { assertValidPatternFragment } from './fragment';
import { DocumentEditor, type HistoryOptions } from './history';
import { commandLayerType, commandScope, findLayer, layeredFromSurface, layerIndex } from './layers';
import { cellIndex, cloneDocument, colorsOffset, createDocument, isThreeQuarterKind, isThreeQuarterPairKind, threeQuarterCornerForKind } from './model';
import {
  CellKind,
  DomainError,
  LayerErrorCode,
  LayerType,
  type BackstitchRecord,
  type BulkCellCommand,
  type BulkCellEdit,
  type BulkRecolorCommand,
  type CatalogAssociation,
  type CommandResult,
  type CreateDocumentOptions,
  type DomainCommand,
  type HalfDirection,
  type LayeredDocument,
  type PatternDocument,
  type PatternFragment,
  type QuarterCorner,
  type SpecialtyLayer,
  type StitchLayer
} from './types';
import { assertValidDocument } from './validation';

/** The "Stitches" layer `layeredFromSurface` puts the cells on. */
export const STITCH_LAYER_ID = 1;
/** The "Specialty" layer `layeredFromSurface` puts the backstitches on. */
export const SPECIALTY_LAYER_ID = 2;

/** The catalog association domain tests create documents with. */
export const TEST_CATALOG: CatalogAssociation = { catalogId: 'test-catalog', brandLabel: 'Test Catalog', colorCount: 489 };
/** The smaller catalog association persistence tests write into saved bytes. */
export const PERSISTENCE_TEST_CATALOG: CatalogAssociation = { catalogId: 'test-catalog-v1', brandLabel: 'Test catalog', colorCount: 32 };

/** The stitch layer `id` of `document`; throws if it is missing or another type. */
export function stitchLayer(document: LayeredDocument, id = STITCH_LAYER_ID): StitchLayer {
  const layer = findLayer(document, id);
  if (layer?.type !== LayerType.Stitch) throw new Error(`Layer ${String(id)} is not a stitch layer.`);
  return layer;
}

/** The specialty layer `id` of `document`; throws if it is missing or another type. */
export function specialtyLayer(document: LayeredDocument, id = SPECIALTY_LAYER_ID): SpecialtyLayer {
  const layer = findLayer(document, id);
  if (layer?.type !== LayerType.Specialty) throw new Error(`Layer ${String(id)} is not a specialty layer.`);
  return layer;
}

/** The code of the `DomainError` `action` throws; any other outcome fails the test. */
export function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('Expected a DomainError.');
}

/**
 * A copy of `document` with cell (x, y) marked complete: every painted
 * component, or only `corner`'s on a quarters or three-quarter pair cell.
 */
export function markCellComplete(document: PatternDocument, x: number, y: number, corner?: QuarterCorner): PatternDocument {
  const next = cloneDocument(document);
  const index = cellIndex(next, x, y);
  const kind = next.kind[index];
  if (kind === CellKind.Empty) throw new Error(`Cell (${String(x)}, ${String(y)}) is empty.`);
  if (kind !== CellKind.Quarters && !isThreeQuarterPairKind(kind)) {
    next.completed[index] = 1;
    return next;
  }
  if (corner !== undefined) {
    next.completed[index] |= 1 << corner;
    return next;
  }
  const offset = colorsOffset(index);
  for (let slot = 0; slot < 4; slot += 1) if (next.colors[offset + slot] !== 0) next.completed[index] |= 1 << slot;
  return next;
}

/** A copy of `document` with backstitch `id` marked complete. */
export function markBackstitchComplete(document: PatternDocument, id: number): PatternDocument {
  const next = cloneDocument(document);
  const position = next.backstitches.ids.indexOf(id);
  if (position < 0) throw new Error(`Backstitch ${String(id)} does not exist.`);
  next.backstitches.completed[position] = 1;
  return next;
}

/** `layeredFromSurface`, keeping the surface's completion on the default layers and its canvas frame. */
export function layeredWithProgress(surface: PatternDocument): LayeredDocument {
  const layered = layeredFromSurface(cloneDocument(surface));
  return {
    ...layered,
    ...(surface.originX === undefined ? {} : { originX: surface.originX }),
    ...(surface.originY === undefined ? {} : { originY: surface.originY }),
    ...(surface.canvasMask === undefined ? {} : { canvasMask: surface.canvasMask.slice() }),
    layers: layered.layers.map((layer) => layer.type === LayerType.Stitch
      ? { ...layer, completed: surface.completed.slice() }
      : { ...layer, backstitches: { ...layer.backstitches, completed: surface.backstitches.completed.slice() } })
  };
}

/** A document editor over `surface`, keeping its completion. */
export function editorFromSurface(surface: PatternDocument, options?: HistoryOptions): DocumentEditor {
  return new DocumentEditor(layeredWithProgress(surface), options);
}

/**
 * Targets a layer edit at the default layer for its kind, as the session
 * targets the active layer. An edit for either kind (a delete or a move) goes
 * to both layers as one batch, as a selection over both layers does.
 */
export function onDefaultLayers(command: DomainCommand): DomainCommand {
  if (command.type === 'batch') return { ...command, commands: command.commands.map(onDefaultLayers) };
  if (command.layerId !== undefined || commandScope(command) !== 'layer') return command;
  const layerType = commandLayerType(command);
  if (layerType === LayerType.Stitch) return { ...command, layerId: STITCH_LAYER_ID };
  if (layerType === LayerType.Specialty) return { ...command, layerId: SPECIALTY_LAYER_ID };
  if (layerType === null) return { type: 'batch', commands: [{ ...command, layerId: STITCH_LAYER_ID }, { ...command, layerId: SPECIALTY_LAYER_ID }] };
  return command;
}

export function bulkCellCommand(indices: Uint32Array, edit: BulkCellEdit, expectedRevision?: number): BulkCellCommand {
  return { type: 'bulk-cell', indices: indices.slice(), edit: { ...edit }, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

export function bulkRecolorCommand(indices: Uint32Array, masks: Uint8Array, fromColor: number, toColor: number, expectedRevision?: number): BulkRecolorCommand {
  return { type: 'bulk-recolor', indices: indices.slice(), masks: masks.slice(), fromColor, toColor, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

export function bulkSetFullCommand(indices: Uint32Array, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'full', color }, expectedRevision);
}

export function bulkSetHalfCommand(indices: Uint32Array, direction: HalfDirection, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'half', direction, color }, expectedRevision);
}

export function bulkSetQuarterCommand(indices: Uint32Array, corner: QuarterCorner, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'quarter', corner, color }, expectedRevision);
}

export function bulkSetThreeQuarterCommand(indices: Uint32Array, corner: QuarterCorner, color: number, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'three-quarter', corner, color }, expectedRevision);
}

export function bulkEraseCellCommand(indices: Uint32Array, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'erase-cell' }, expectedRevision);
}

export function bulkEraseQuarterCommand(indices: Uint32Array, corner: QuarterCorner, expectedRevision?: number): BulkCellCommand {
  return bulkCellCommand(indices, { kind: 'erase-quarter', corner }, expectedRevision);
}

function sameContent(left: PatternDocument, right: PatternDocument): boolean {
  if (left.width !== right.width || left.height !== right.height || left.palette.length !== right.palette.length || left.backstitches.ids.length !== right.backstitches.ids.length || left.nextBackstitchId !== right.nextBackstitchId || left.nextPaletteId !== right.nextPaletteId) return false;
  if (!settingsEqual(left.settings, right.settings)) return false;
  if (!typedArraysEqual(left.kind, right.kind) || !typedArraysEqual(left.completed, right.completed) || !typedArraysEqual(left.colors, right.colors)) return false;
  if (!palettesEqual(left.palette, right.palette)) return false;
  return backstitchStoresEqual(left.backstitches, right.backstitches);
}

export function applyCommand(document: PatternDocument, command: DomainCommand): CommandResult {
  assertValidDocument(document);
  const draft = cloneDocument(document);
  const commandList = command.type === 'batch' ? command.commands : [command];
  const snapshot = commandRequiresSnapshot(command);
  const tracker = snapshot ? undefined : new MutationTracker();
  const result = applyCommandsToDraft(draft, commandList, tracker);
  if (!result.changed || (!snapshot && !tracker?.hasChanges(draft) && result.delta === undefined) || (snapshot && sameContent(document, draft))) {
    return {
      document,
      changed: false,
      revision: document.revision,
      ...(result.touchedIndices === undefined ? {} : { touchedIndices: result.touchedIndices.slice() }),
      ...(result.changedIndices === undefined ? {} : { changedIndices: result.changedIndices.slice() }),
      ...(result.touchedBackstitchIds === undefined ? {} : { touchedBackstitchIds: result.touchedBackstitchIds.slice() }),
      ...(result.changedBackstitchIds === undefined ? {} : { changedBackstitchIds: result.changedBackstitchIds.slice() }),
      ...(result.progress === undefined ? {} : { progress: { cellIndices: result.progress.cellIndices.slice(), backstitchIds: result.progress.backstitchIds.slice(), marked: result.progress.marked, unmarked: result.progress.unmarked } }),
      ...(result.recalculateMetrics === undefined ? {} : { recalculateMetrics: result.recalculateMetrics }),
      ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() }),
      ...(result.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: result.movedBackstitchIds.slice() })
    };
  }
  draft.revision = document.revision + 1;
  assertValidDocument(draft);
  return {
    document: draft,
    changed: true,
    revision: draft.revision,
    backstitchId: result.backstitchId,
    paletteId: result.paletteId,
    ...(result.touchedIndices === undefined ? {} : { touchedIndices: result.touchedIndices.slice() }),
    ...(result.changedIndices === undefined ? {} : { changedIndices: result.changedIndices.slice() }),
    ...(result.touchedBackstitchIds === undefined ? {} : { touchedBackstitchIds: result.touchedBackstitchIds.slice() }),
    ...(result.changedBackstitchIds === undefined ? {} : { changedBackstitchIds: result.changedBackstitchIds.slice() }),
    ...(result.progress === undefined ? {} : { progress: { cellIndices: result.progress.cellIndices.slice(), backstitchIds: result.progress.backstitchIds.slice(), marked: result.progress.marked, unmarked: result.progress.unmarked } }),
    ...(result.recalculateMetrics === undefined ? {} : { recalculateMetrics: result.recalculateMetrics }),
    ...(result.createdBackstitchIds === undefined ? {} : { createdBackstitchIds: result.createdBackstitchIds.slice() }),
    ...(result.movedBackstitchIds === undefined ? {} : { movedBackstitchIds: result.movedBackstitchIds.slice() })
  };
}

export function getBackstitch(
  document: PatternDocument,
  id: number
): BackstitchRecord | undefined {
  const index = document.backstitches.ids.findIndex((candidate) => candidate === id);
  return index < 0 ? undefined : readBackstitch(document.backstitches, index);
}

export function getCell(document: PatternDocument, x: number, y: number) {
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index);
  const kind = document.kind[index];
  const completion = document.completed[index];
  const threeQuarterCorners = isThreeQuarterKind(kind) || isThreeQuarterPairKind(kind) ? threeQuarterCornersForCell(document, index) : [];
  const primaryThreeQuarterCorner = threeQuarterCorners[0];
  const color = isThreeQuarterPairKind(kind) && primaryThreeQuarterCorner !== undefined
    ? document.colors[offset + primaryThreeQuarterCorner]
    : document.colors[offset];
  const completed = isThreeQuarterPairKind(kind) && primaryThreeQuarterCorner !== undefined
    ? (completion & (1 << primaryThreeQuarterCorner)) !== 0
    : (completion & 1) !== 0;
  return {
    x,
    y,
    kind,
    color,
    completed,
    completionMask: completion,
    quarters: [
      { color: kind === CellKind.Quarters ? document.colors[offset] : 0, completed: kind === CellKind.Quarters && (completion & 1) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 1] : 0, completed: kind === CellKind.Quarters && (completion & 2) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 2] : 0, completed: kind === CellKind.Quarters && (completion & 4) !== 0 },
      { color: kind === CellKind.Quarters ? document.colors[offset + 3] : 0, completed: kind === CellKind.Quarters && (completion & 8) !== 0 }
    ] as const,
    threeQuarters: [0, 1, 2, 3].map((corner) => getThreeQuarterAtIndex(document, index, corner as QuarterCorner)) as readonly { color: number; completed: boolean }[]
  };
}

export function getQuarter(document: PatternDocument, x: number, y: number, corner: number) {
  if (!Number.isSafeInteger(corner) || corner < 0 || corner > 3) {
    throw new DomainError('invalid-corner', `Quarter corner ${String(corner)} is invalid.`);
  }
  const index = cellIndex(document, x, y);
  const offset = colorsOffset(index) + corner;
  return {
    color: document.kind[index] === CellKind.Quarters ? document.colors[offset] : 0,
    completed: document.kind[index] === CellKind.Quarters && (document.completed[index] & (1 << corner)) !== 0
  };
}

export function isQuarterKind(kind: number): boolean {
  return kind === CellKind.Quarters;
}

function getThreeQuarterAtIndex(document: PatternDocument, index: number, corner: QuarterCorner): { color: number; completed: boolean } {
  const kind = document.kind[index];
  const offset = colorsOffset(index);
  const singleCorner = threeQuarterCornerForKind(kind);
  if (singleCorner === corner) return { color: document.colors[offset], completed: (document.completed[index] & 1) !== 0 };
  if (isThreeQuarterPairKind(kind)) return { color: document.colors[offset + corner], completed: (document.completed[index] & (1 << corner)) !== 0 };
  return { color: 0, completed: false };
}

function threeQuarterCornersForCell(document: PatternDocument, index: number): QuarterCorner[] {
  const kind = document.kind[index];
  const singleCorner = threeQuarterCornerForKind(kind);
  if (singleCorner !== undefined) return document.colors[index * 4] === 0 ? [] : [singleCorner];
  if (!isThreeQuarterPairKind(kind)) return [];
  const offset = index * 4;
  return [0, 1, 2, 3].filter((corner) => document.colors[offset + corner] !== 0) as QuarterCorner[];
}

/** Canvas settings plus "Stitches" (id 1) and "Specialty" (id 2). */
export function createLayeredDocument(options: CreateDocumentOptions): LayeredDocument {
  return layeredFromSurface(createDocument(options));
}

/**
 * Writes a surface back to its layer: cell planes (stitch) or the backstitch
 * store (specialty), plus palette, settings and counters. Width, height and
 * the canvas fields are not written.
 */
export function commitLayerSurface(document: LayeredDocument, layerId: number, surface: PatternDocument): void {
  const index = layerIndex(document, layerId);
  if (index < 0) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(layerId)} does not exist.`);
  const layer = document.layers[index];
  if (layer.type === LayerType.Stitch) {
    layer.kind = surface.kind;
    layer.colors = surface.colors;
    layer.completed = surface.completed;
  } else {
    layer.backstitches = surface.backstitches;
  }
  document.palette = surface.palette;
  document.settings = surface.settings;
  document.revision = surface.revision;
  document.nextBackstitchId = surface.nextBackstitchId;
  document.nextPaletteId = surface.nextPaletteId;
}

export function readPatternFragmentCell(fragment: PatternFragment, x: number, y: number): { x: number; y: number; kind: CellKind; colors: Uint16Array } {
  assertValidPatternFragment(fragment);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= fragment.width || y >= fragment.height) throw new DomainError('out-of-bounds', `Fragment cell (${String(x)}, ${String(y)}) is out of bounds.`);
  const offset = (y * fragment.width + x) * 4;
  return { x, y, kind: fragment.kind[y * fragment.width + x] as CellKind, colors: fragment.colors.slice(offset, offset + 4) };
}

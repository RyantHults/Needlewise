// Fixtures for domain tests. Marks are Track progress, not editor edits, so
// these write `completed` on a copy instead of going through a command or a
// history. Editors start from `layeredFromSurface`'s two default layers.
import { DocumentEditor, type HistoryOptions } from './history';
import { commandLayerType, commandScope, layeredFromSurface } from './layers';
import { cellIndex, cloneDocument, colorsOffset, isThreeQuarterPairKind } from './model';
import { CellKind, LayerType, type DomainCommand, type LayeredDocument, type PatternDocument, type QuarterCorner } from './types';

/** The "Stitches" layer `layeredFromSurface` puts the cells on. */
export const STITCH_LAYER_ID = 1;
/** The "Specialty" layer `layeredFromSurface` puts the backstitches on. */
export const SPECIALTY_LAYER_ID = 2;

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

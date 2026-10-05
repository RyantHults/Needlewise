import {
  CellKind,
  DOCUMENT_SCHEMA_VERSION,
  DomainError,
  LAYERED_DOCUMENT_VERSION,
  LayerErrorCode,
  LayerType,
  MAX_LAYERS_PER_TYPE,
  MAX_LAYER_NAME_CHARS,
  MAX_PERSISTABLE_CELL_COUNT,
  type BackstitchStore,
  type CreateDocumentOptions,
  type DomainCommand,
  type Layer,
  type LayerAddCommand,
  type LayerDeleteCommand,
  type LayerDuplicateCommand,
  type LayeredDocument,
  type LayerMergeCommand,
  type LayerMoveCommand,
  type LayerRenameCommand,
  type LayerSetVisibilityCommand,
  type LayerStructureCommand,
  type PatternDocument,
  type PatternSettings,
  type SpecialtyLayer,
  type StitchLayer
} from './types';
import { UINT32_MAX, createDocument, emptyBackstitches, normalizePatternSettings } from './model';
import { collectValidationErrors } from './validation';
import { canvasFields, isCanvasCommand } from './canvas';

const DEFAULT_LAYER_NAMES: Record<LayerType, string> = {
  [LayerType.Stitch]: 'Stitches',
  [LayerType.Specialty]: 'Specialty'
};

// ---------------------------------------------------------------------------
// Creation

/** Canvas settings plus "Stitches" (id 1) and "Specialty" (id 2). */
export function createLayeredDocument(options: CreateDocumentOptions): LayeredDocument {
  return layeredFromSurface(createDocument(options));
}

/**
 * Builds a layered document from a single surface: cells go to "Stitches",
 * backstitches to "Specialty", and completion is dropped. The new layers take
 * ownership of the surface's kind/colors planes and backstitch coordinates.
 */
export function layeredFromSurface(surface: PatternDocument, settings?: Partial<PatternSettings>): LayeredDocument {
  const cellCount = surface.width * surface.height;
  const stitches: StitchLayer = {
    id: 1,
    type: LayerType.Stitch,
    name: DEFAULT_LAYER_NAMES[LayerType.Stitch],
    visible: true,
    kind: surface.kind,
    colors: surface.colors,
    completed: new Uint8Array(cellCount)
  };
  const specialty: SpecialtyLayer = {
    id: 2,
    type: LayerType.Specialty,
    name: DEFAULT_LAYER_NAMES[LayerType.Specialty],
    visible: true,
    backstitches: { ...surface.backstitches, completed: new Uint8Array(surface.backstitches.ids.length) }
  };
  return {
    version: LAYERED_DOCUMENT_VERSION,
    catalog: { catalogId: surface.catalog.catalogId, brandLabel: surface.catalog.brandLabel, colorCount: surface.catalog.colorCount },
    width: surface.width,
    height: surface.height,
    layers: [stitches, specialty],
    palette: surface.palette,
    settings: normalizePatternSettings({ ...surface.settings, ...settings }),
    revision: surface.revision,
    nextBackstitchId: surface.nextBackstitchId,
    nextPaletteId: surface.nextPaletteId,
    nextLayerId: 3
  };
}

// ---------------------------------------------------------------------------
// Queries

export function findLayer(document: LayeredDocument, layerId: number): Layer | undefined {
  return document.layers.find((layer) => layer.id === layerId);
}

export function requireLayer(document: LayeredDocument, layerId: number): Layer {
  const layer = findLayer(document, layerId);
  if (!layer) throw new DomainError(LayerErrorCode.NotFound, `Layer ${String(layerId)} does not exist.`);
  return layer;
}

export function layerIndex(document: LayeredDocument, layerId: number): number {
  return document.layers.findIndex((layer) => layer.id === layerId);
}

/** Bottom to top. */
export function layersOfType(document: LayeredDocument, type: LayerType): Layer[] {
  return document.layers.filter((layer) => layer.type === type);
}

/** The half-open index range `[start, end)` a layer type occupies in `layers`. */
export function layerGroupRange(document: LayeredDocument, type: LayerType): { start: number; end: number } {
  const stitchCount = document.layers.reduce((count, layer) => count + (layer.type === LayerType.Stitch ? 1 : 0), 0);
  return type === LayerType.Stitch ? { start: 0, end: stitchCount } : { start: stitchCount, end: document.layers.length };
}

export function canAddLayer(document: LayeredDocument, type: LayerType): boolean {
  return layersOfType(document, type).length < MAX_LAYERS_PER_TYPE;
}

/** "Stitches", "Stitches 2", …; the lowest free number wins. */
export function nextDefaultLayerName(document: LayeredDocument, type: LayerType): string {
  const base = DEFAULT_LAYER_NAMES[type];
  const names = new Set(document.layers.map((layer) => layer.name));
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? base : `${base} ${String(number)}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** The topmost visible layer, optionally of one type. */
export function topmostVisibleLayer(document: LayeredDocument, type?: LayerType): Layer | undefined {
  for (let index = document.layers.length - 1; index >= 0; index -= 1) {
    const layer = document.layers[index];
    if (layer.visible && (type === undefined || layer.type === type)) return layer;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Surfaces

interface ZeroPlanes {
  readonly kind: Uint8Array;
  readonly colors: Uint16Array;
  readonly completed: Uint8Array;
}

interface ZeroPlaneSlot extends ZeroPlanes {
  readonly width: number;
  readonly height: number;
}

// One slot for the current size: a new size replaces it, so at most one set is retained.
let zeroPlaneSlot: ZeroPlaneSlot | null = null;

/** Shared all-zero cell planes for specialty surfaces. They must never be written. */
function zeroPlanes(width: number, height: number): ZeroPlanes {
  if (zeroPlaneSlot?.width === width && zeroPlaneSlot.height === height) return zeroPlaneSlot;
  const cellCount = width * height;
  zeroPlaneSlot = { width, height, kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4), completed: new Uint8Array(cellCount) };
  return zeroPlaneSlot;
}

/** True for the shared cell planes behind specialty surfaces. */
export function isSharedEmptyCellPlane(plane: ArrayBufferView): boolean {
  const slot = zeroPlaneSlot;
  return slot !== null && (plane === slot.kind || plane === slot.colors || plane === slot.completed);
}

/**
 * A single-surface view of one layer. Stitch surfaces alias the layer's cell
 * planes and carry an empty backstitch store; specialty surfaces alias the
 * backstitch store over shared all-zero cell planes. Palette and settings are
 * shared by reference; counters are copied.
 */
export function layerSurface(document: LayeredDocument, layerId: number): PatternDocument {
  const layer = requireLayer(document, layerId);
  const planes = layer.type === LayerType.Stitch ? layer : zeroPlanes(document.width, document.height);
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: document.catalog,
    width: document.width,
    height: document.height,
    kind: planes.kind,
    colors: planes.colors,
    completed: planes.completed,
    backstitches: layer.type === LayerType.Specialty ? layer.backstitches : emptyBackstitches(),
    palette: document.palette,
    settings: document.settings,
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    ...canvasFields(document)
  };
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

// ---------------------------------------------------------------------------
// Flattening

function segmentKey(store: BackstitchStore, index: number): string {
  return `${String(store.x1[index])},${String(store.y1[index])},${String(store.x2[index])},${String(store.y2[index])}`;
}

/**
 * Concatenates visible specialty stores bottom to top. When the same segment
 * appears on several layers only the topmost copy is kept, so the composite
 * stays a valid single surface.
 */
function flattenBackstitches(document: LayeredDocument): BackstitchStore {
  const stores = document.layers.filter((layer): layer is SpecialtyLayer => layer.type === LayerType.Specialty && layer.visible).map((layer) => layer.backstitches);
  if (stores.length === 0) return emptyBackstitches();
  if (stores.length === 1) return copyStore(stores[0]);
  const keep: boolean[][] = stores.map((store) => new Array<boolean>(store.ids.length).fill(true));
  const seen = new Set<string>();
  let total = 0;
  for (let storeIndex = stores.length - 1; storeIndex >= 0; storeIndex -= 1) {
    const store = stores[storeIndex];
    for (let index = store.ids.length - 1; index >= 0; index -= 1) {
      const key = segmentKey(store, index);
      if (seen.has(key)) keep[storeIndex][index] = false;
      else {
        seen.add(key);
        total += 1;
      }
    }
  }
  const result = allocateStore(total);
  let cursor = 0;
  stores.forEach((store, storeIndex) => {
    for (let index = 0; index < store.ids.length; index += 1) {
      if (!keep[storeIndex][index]) continue;
      copyRecord(store, index, result, cursor);
      cursor += 1;
    }
  });
  return result;
}

function allocateStore(length: number): BackstitchStore {
  return {
    ids: new Uint32Array(length),
    x1: new Uint32Array(length),
    y1: new Uint32Array(length),
    x2: new Uint32Array(length),
    y2: new Uint32Array(length),
    colors: new Uint16Array(length),
    completed: new Uint8Array(length)
  };
}

function copyStore(store: BackstitchStore): BackstitchStore {
  return {
    ids: store.ids.slice(),
    x1: store.x1.slice(),
    y1: store.y1.slice(),
    x2: store.x2.slice(),
    y2: store.y2.slice(),
    colors: store.colors.slice(),
    completed: store.completed.slice()
  };
}

function copyRecord(from: BackstitchStore, fromIndex: number, to: BackstitchStore, toIndex: number, id = from.ids[fromIndex]): void {
  to.ids[toIndex] = id;
  to.x1[toIndex] = from.x1[fromIndex];
  to.y1[toIndex] = from.y1[fromIndex];
  to.x2[toIndex] = from.x2[fromIndex];
  to.y2[toIndex] = from.y2[fromIndex];
  to.colors[toIndex] = from.colors[fromIndex];
  to.completed[toIndex] = from.completed[fromIndex];
}

function visibleStitchLayers(document: LayeredDocument): StitchLayer[] {
  return document.layers.filter((layer): layer is StitchLayer => layer.type === LayerType.Stitch && layer.visible);
}

/** Writes the covering result for one cell: the topmost visible non-empty stitch cell. */
function flattenCell(stitchLayers: readonly StitchLayer[], kind: Uint8Array, colors: Uint16Array, index: number): void {
  const offset = index * 4;
  for (let layerIndex = stitchLayers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = stitchLayers[layerIndex];
    if (layer.kind[index] === CellKind.Empty) continue;
    kind[index] = layer.kind[index];
    colors[offset] = layer.colors[offset];
    colors[offset + 1] = layer.colors[offset + 1];
    colors[offset + 2] = layer.colors[offset + 2];
    colors[offset + 3] = layer.colors[offset + 3];
    return;
  }
  kind[index] = CellKind.Empty;
  colors[offset] = 0;
  colors[offset + 1] = 0;
  colors[offset + 2] = 0;
  colors[offset + 3] = 0;
}

function flattenCells(document: LayeredDocument, kind: Uint8Array, colors: Uint16Array): void {
  const stitchLayers = visibleStitchLayers(document);
  kind.fill(0);
  colors.fill(0);
  for (const layer of stitchLayers) {
    const source = layer.kind;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === CellKind.Empty) continue;
      kind[index] = source[index];
      const offset = index * 4;
      colors[offset] = layer.colors[offset];
      colors[offset + 1] = layer.colors[offset + 1];
      colors[offset + 2] = layer.colors[offset + 2];
      colors[offset + 3] = layer.colors[offset + 3];
    }
  }
}

/**
 * The visible composite as a single surface. Stitch cells follow the covering
 * rule, `completed` is zero, backstitches are the visible specialty layers
 * bottom to top, and palette/settings are shared by reference.
 */
export function flattenDocument(document: LayeredDocument): PatternDocument {
  const cellCount = document.width * document.height;
  const kind = new Uint8Array(cellCount);
  const colors = new Uint16Array(cellCount * 4);
  flattenCells(document, kind, colors);
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    catalog: document.catalog,
    width: document.width,
    height: document.height,
    kind,
    colors,
    completed: new Uint8Array(cellCount),
    backstitches: flattenBackstitches(document),
    palette: document.palette,
    settings: document.settings,
    revision: document.revision,
    nextBackstitchId: document.nextBackstitchId,
    nextPaletteId: document.nextPaletteId,
    ...canvasFields(document)
  };
}

/** True when the composite no longer matches the document's frame: size, catalog, origin or mask. */
function frameChanged(previous: PatternDocument, document: LayeredDocument): boolean {
  return previous.width !== document.width
    || previous.height !== document.height
    || previous.catalog !== document.catalog
    || previous.canvasMask !== document.canvasMask
    || previous.originX !== document.originX
    || previous.originY !== document.originY;
}

/**
 * Keeps one composite up to date. Composites are immutable snapshots: `update`
 * returns a new composite each call, copying the kind/colors planes before
 * recomputing `changedIndices`, and always recomputes backstitches and
 * refreshes shared fields. The completed plane stays shared. Structure changes
 * (visibility, order, delete, merge) and canvas changes need `full`; `update`
 * and `touch` fall back to it when the size, origin or mask no longer match.
 */
export class FlattenCache {
  private composite: PatternDocument | null = null;

  get document(): PatternDocument | null {
    return this.composite;
  }

  full(document: LayeredDocument): PatternDocument {
    this.composite = flattenDocument(document);
    return this.composite;
  }

  update(document: LayeredDocument, changedIndices?: Uint32Array): PatternDocument {
    const previous = this.composite;
    if (!previous || frameChanged(previous, document)) return this.full(document);
    let kind = previous.kind;
    let colors = previous.colors;
    if (changedIndices && changedIndices.length > 0) {
      kind = kind.slice();
      colors = colors.slice();
      const stitchLayers = visibleStitchLayers(document);
      for (const index of changedIndices) flattenCell(stitchLayers, kind, colors, index);
    }
    this.composite = {
      ...previous,
      kind,
      colors,
      backstitches: flattenBackstitches(document),
      palette: document.palette,
      settings: document.settings,
      revision: document.revision,
      nextBackstitchId: document.nextBackstitchId,
      nextPaletteId: document.nextPaletteId
    };
    return this.composite;
  }

  /**
   * A new composite that shares every plane and the backstitch store, for
   * changes that cannot alter composite content (rename, palette or settings).
   */
  touch(document: LayeredDocument): PatternDocument {
    const previous = this.composite;
    if (!previous || frameChanged(previous, document)) return this.full(document);
    this.composite = {
      ...previous,
      palette: document.palette,
      settings: document.settings,
      revision: document.revision,
      nextBackstitchId: document.nextBackstitchId,
      nextPaletteId: document.nextPaletteId
    };
    return this.composite;
  }

  clear(): void {
    this.composite = null;
  }
}

// ---------------------------------------------------------------------------
// Command scope

export type CommandScope = 'layer' | 'document' | 'structure' | 'canvas';

function normalizedCommandType(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function isDocumentCommandType(type: string): boolean {
  return type.includes('palette')
    || type === 'deactivate-color'
    || type === 'document-settings-update';
}

/**
 * `structure` for layer-* commands; `canvas` for canvas-resize and
 * canvas-cells; `document` for palette and settings; `layer` for everything
 * else (cell, backstitch, fragment, erase and delete commands), which must
 * carry a `layerId`. A batch takes the broadest scope of its children:
 * structure, then canvas, then document, then layer.
 */
export function commandScope(command: DomainCommand): CommandScope {
  const type = normalizedCommandType(command.type);
  if (type === 'batch') {
    const children = Array.isArray(command.commands) ? command.commands as DomainCommand[] : [];
    const scopes = children.map(commandScope);
    if (scopes.includes('structure')) return 'structure';
    if (scopes.includes('canvas')) return 'canvas';
    if (scopes.includes('document')) return 'document';
    return 'layer';
  }
  if (type.startsWith('layer-')) return 'structure';
  if (isCanvasCommand(command)) return 'canvas';
  if (isDocumentCommandType(type)) return 'document';
  return 'layer';
}

export function isLayerStructureCommand(command: DomainCommand): command is LayerStructureCommand {
  return typeof command.type === 'string' && command.type.startsWith('layer-');
}

/**
 * The layer type a layer-scoped command needs, or null when it works on both
 * (delete-region, delete-cell-set, move-fragment, an empty paste). A paste
 * holding both cells and backstitches needs both, which no layer satisfies,
 * so it reports 'mixed'.
 */
export function commandLayerType(command: DomainCommand): LayerType | 'mixed' | null {
  const type = normalizedCommandType(command.type);
  if (type === 'paste' || type.startsWith('paste-fragment')) {
    const fragment = command.fragment as { kind?: Uint8Array; backstitches?: { x1?: Uint32Array } } | undefined;
    const hasCells = fragment?.kind?.some((value) => value !== CellKind.Empty) === true;
    const hasLines = (fragment?.backstitches?.x1?.length ?? 0) > 0;
    if (hasCells && hasLines) return 'mixed';
    if (hasCells) return LayerType.Stitch;
    if (hasLines) return LayerType.Specialty;
    return null;
  }
  if (type === 'batch') {
    const children = Array.isArray(command.commands) ? command.commands as DomainCommand[] : [];
    let required: LayerType | null = null;
    for (const child of children) {
      if (commandScope(child) !== 'layer') continue;
      const childType = commandLayerType(child);
      if (childType === 'mixed') return 'mixed';
      if (childType === null) continue;
      if (required !== null && required !== childType) return 'mixed';
      required = childType;
    }
    return required;
  }
  if (type.startsWith('move-fragment') || type === 'move' || type.startsWith('delete-region') || type === 'delete-selection' || type === 'clear-region' || type === 'erase-region' || type.startsWith('delete-cell-set') || type === 'delete-cells') return null;
  if (type.includes('backstitch') || type.includes('back-stitch') || type.includes('segment')) return LayerType.Specialty;
  return LayerType.Stitch;
}

/**
 * The layer a layer-scoped edit may target: it must exist, be visible, and
 * match `requiredType` when one is given.
 */
export function requireEditableLayer(document: LayeredDocument, layerId: number, requiredType?: LayerType | 'mixed' | null): Layer {
  const layer = requireLayer(document, layerId);
  if (!layer.visible) throw new DomainError(LayerErrorCode.Hidden, 'Show this layer to edit it.');
  if (requiredType === 'mixed' || (requiredType != null && requiredType !== layer.type)) {
    throw new DomainError(LayerErrorCode.TypeMismatch, `This edit cannot be applied to a ${layer.type} layer.`);
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Structure commands

export function layerAddCommand(layerType: LayerType, options: { id?: number; name?: string; index?: number } = {}): LayerAddCommand {
  return { type: 'layer-add', layerType, ...options };
}

export function layerDeleteCommand(layerId: number): LayerDeleteCommand {
  return { type: 'layer-delete', layerId };
}

export function layerMoveCommand(layerId: number, toIndex: number): LayerMoveCommand {
  return { type: 'layer-move', layerId, toIndex };
}

export function layerRenameCommand(layerId: number, name: string): LayerRenameCommand {
  return { type: 'layer-rename', layerId, name };
}

export function layerSetVisibilityCommand(layerId: number, visible: boolean): LayerSetVisibilityCommand {
  return { type: 'layer-set-visibility', layerId, visible };
}

export function layerDuplicateCommand(layerId: number): LayerDuplicateCommand {
  return { type: 'layer-duplicate', layerId };
}

export function layerMergeCommand(sourceId: number, targetId: number): LayerMergeCommand {
  return { type: 'layer-merge', sourceId, targetId };
}

export interface LayerStructureResult {
  readonly changed: boolean;
  /** The created layer (add, duplicate), the merge target, or the command's subject. */
  readonly layerId?: number;
}

function invalidCommand(message: string): never {
  throw new DomainError('invalid-command', message);
}

function commandInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidCommand(`${label} must be an integer.`);
  return value;
}

/** Trims a layer name and checks it is 1–60 characters. */
export function normalizeLayerName(name: unknown): string {
  if (typeof name !== 'string') throw new DomainError('invalid-layer-name', 'Layer names must be strings.');
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > MAX_LAYER_NAME_CHARS) throw new DomainError('invalid-layer-name', `Layer names must be 1 to ${String(MAX_LAYER_NAME_CHARS)} characters.`);
  return trimmed;
}

function duplicateName(name: string): string {
  const suffix = ' copy';
  const room = MAX_LAYER_NAME_CHARS - suffix.length;
  const characters = Array.from(name);
  return `${characters.length > room ? characters.slice(0, room).join('').trimEnd() : name}${suffix}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Applies a layer-structure command to `document` in place. Existing Layer
 * objects are never mutated: renames and visibility changes replace the
 * entry, merges build a new target, so a shallow copy of `layers` taken
 * beforehand restores the prior stack. Revision is left to the caller.
 */
export function applyLayerStructureCommand(document: LayeredDocument, command: DomainCommand): LayerStructureResult {
  const finish = (changed: boolean, layerId?: number): LayerStructureResult => ({ changed, ...(layerId === undefined ? {} : { layerId }) });
  switch (command.type) {
    case 'layer-add': {
      const layerType = command.layerType;
      if (layerType !== LayerType.Stitch && layerType !== LayerType.Specialty) invalidCommand('layer-add requires a stitch or specialty layerType.');
      if (!canAddLayer(document, layerType)) throw new DomainError(LayerErrorCode.Limit, `A pattern can have at most ${String(MAX_LAYERS_PER_TYPE)} ${layerType} layers.`);
      let id = document.nextLayerId;
      if (command.id !== undefined) {
        id = commandInteger(command.id, 'layer-add id');
        if (id < 1 || findLayer(document, id)) invalidCommand(`Layer id ${String(id)} is invalid or already used.`);
      }
      const name = command.name === undefined ? nextDefaultLayerName(document, layerType) : normalizeLayerName(command.name);
      const cellCount = document.width * document.height;
      const layer: Layer = layerType === LayerType.Stitch
        ? { id, type: LayerType.Stitch, name, visible: true, kind: new Uint8Array(cellCount), colors: new Uint16Array(cellCount * 4), completed: new Uint8Array(cellCount) }
        : { id, type: LayerType.Specialty, name, visible: true, backstitches: emptyBackstitches() };
      const range = layerGroupRange(document, layerType);
      const index = command.index === undefined ? range.end : clamp(commandInteger(command.index, 'layer-add index'), range.start, range.end);
      const layers = [...document.layers];
      layers.splice(index, 0, layer);
      document.layers = layers;
      document.nextLayerId = Math.max(document.nextLayerId, id + 1);
      return finish(true, id);
    }
    case 'layer-delete': {
      const layerId = commandInteger(command.layerId, 'layerId');
      requireLayer(document, layerId);
      document.layers = document.layers.filter((layer) => layer.id !== layerId);
      return finish(true, layerId);
    }
    case 'layer-move': {
      const layerId = commandInteger(command.layerId, 'layerId');
      const layer = requireLayer(document, layerId);
      const from = layerIndex(document, layerId);
      const range = layerGroupRange(document, layer.type);
      const to = clamp(commandInteger(command.toIndex, 'toIndex'), range.start, range.end - 1);
      if (to === from) return finish(false, layerId);
      const layers = [...document.layers];
      layers.splice(from, 1);
      layers.splice(to, 0, layer);
      document.layers = layers;
      return finish(true, layerId);
    }
    case 'layer-rename': {
      const layerId = commandInteger(command.layerId, 'layerId');
      const layer = requireLayer(document, layerId);
      const name = normalizeLayerName(command.name);
      if (name === layer.name) return finish(false, layerId);
      document.layers = document.layers.map((entry) => entry.id === layerId ? { ...entry, name } : entry);
      return finish(true, layerId);
    }
    case 'layer-set-visibility': {
      const layerId = commandInteger(command.layerId, 'layerId');
      const layer = requireLayer(document, layerId);
      if (typeof command.visible !== 'boolean') invalidCommand('layer-set-visibility requires a boolean visible flag.');
      const visible = command.visible;
      if (visible === layer.visible) return finish(false, layerId);
      document.layers = document.layers.map((entry) => entry.id === layerId ? { ...entry, visible } : entry);
      return finish(true, layerId);
    }
    case 'layer-duplicate': {
      const layerId = commandInteger(command.layerId, 'layerId');
      const source = requireLayer(document, layerId);
      if (!canAddLayer(document, source.type)) throw new DomainError(LayerErrorCode.Limit, `A pattern can have at most ${String(MAX_LAYERS_PER_TYPE)} ${source.type} layers.`);
      const id = document.nextLayerId;
      const name = duplicateName(source.name);
      let copy: Layer;
      if (source.type === LayerType.Stitch) {
        copy = { id, type: LayerType.Stitch, name, visible: source.visible, kind: source.kind.slice(), colors: source.colors.slice(), completed: new Uint8Array(source.kind.length) };
      } else {
        const count = source.backstitches.ids.length;
        if (document.nextBackstitchId + count > UINT32_MAX + 1) throw new DomainError('backstitch-id-exhausted', 'No backstitch IDs remain for this duplicate.');
        const backstitches = allocateStore(count);
        for (let index = 0; index < count; index += 1) copyRecord(source.backstitches, index, backstitches, index, document.nextBackstitchId + index);
        copy = { id, type: LayerType.Specialty, name, visible: source.visible, backstitches };
        document.nextBackstitchId += count;
      }
      const layers = [...document.layers];
      layers.splice(layerIndex(document, layerId) + 1, 0, copy);
      document.layers = layers;
      document.nextLayerId = id + 1;
      return finish(true, id);
    }
    case 'layer-merge': {
      const sourceId = commandInteger(command.sourceId, 'sourceId');
      const targetId = commandInteger(command.targetId, 'targetId');
      const source = requireLayer(document, sourceId);
      const target = requireLayer(document, targetId);
      if (sourceId === targetId) throw new DomainError(LayerErrorCode.MergeInvalid, 'A layer cannot be merged into itself.');
      if (source.type !== target.type) throw new DomainError(LayerErrorCode.MergeInvalid, 'Only layers of the same type can be merged.');
      if (!source.visible || !target.visible) throw new DomainError(LayerErrorCode.MergeInvalid, 'Both layers must be visible to merge.');
      const sourceIndex = layerIndex(document, sourceId);
      const targetIndex = layerIndex(document, targetId);
      const [lower, upper] = sourceIndex < targetIndex ? [source, target] : [target, source];
      const merged = mergeLayers(target, lower, upper);
      document.layers = document.layers.filter((layer) => layer.id !== sourceId).map((layer) => layer.id === targetId ? merged : layer);
      return finish(true, targetId);
    }
    default:
      invalidCommand(`Unknown layer structure command ${String(command.type)}.`);
  }
}

/** A new layer with the target's identity and the combined content; `upper` wins conflicts. */
function mergeLayers(target: Layer, lower: Layer, upper: Layer): Layer {
  if (target.type === LayerType.Stitch && lower.type === LayerType.Stitch && upper.type === LayerType.Stitch) {
    const kind = lower.kind.slice();
    const colors = lower.colors.slice();
    for (let index = 0; index < kind.length; index += 1) {
      if (upper.kind[index] === CellKind.Empty) continue;
      kind[index] = upper.kind[index];
      const offset = index * 4;
      colors[offset] = upper.colors[offset];
      colors[offset + 1] = upper.colors[offset + 1];
      colors[offset + 2] = upper.colors[offset + 2];
      colors[offset + 3] = upper.colors[offset + 3];
    }
    return { id: target.id, type: LayerType.Stitch, name: target.name, visible: target.visible, kind, colors, completed: new Uint8Array(kind.length) };
  }
  if (target.type === LayerType.Specialty && lower.type === LayerType.Specialty && upper.type === LayerType.Specialty) {
    const upperKeys = new Set<string>();
    for (let index = 0; index < upper.backstitches.ids.length; index += 1) upperKeys.add(segmentKey(upper.backstitches, index));
    const lowerKept: number[] = [];
    for (let index = 0; index < lower.backstitches.ids.length; index += 1) if (!upperKeys.has(segmentKey(lower.backstitches, index))) lowerKept.push(index);
    const backstitches = allocateStore(lowerKept.length + upper.backstitches.ids.length);
    let cursor = 0;
    for (const index of lowerKept) copyRecord(lower.backstitches, index, backstitches, cursor++);
    for (let index = 0; index < upper.backstitches.ids.length; index += 1) copyRecord(upper.backstitches, index, backstitches, cursor++);
    return { id: target.id, type: LayerType.Specialty, name: target.name, visible: target.visible, backstitches };
  }
  throw new DomainError(LayerErrorCode.MergeInvalid, 'Only layers of the same type can be merged.');
}

// ---------------------------------------------------------------------------
// Validation

export function collectLayeredValidationErrors(document: LayeredDocument): string[] {
  const errors: string[] = [];
  if (!document || document.version !== LAYERED_DOCUMENT_VERSION) return [`Layered document version must be ${String(LAYERED_DOCUMENT_VERSION)}.`];
  if (!Number.isInteger(document.width) || !Number.isInteger(document.height) || document.width < 1 || document.height < 1) return ['Document dimensions must be positive integers.'];
  const cellCount = document.width * document.height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_PERSISTABLE_CELL_COUNT) return ['Document dimensions are too large.'];
  if (!Array.isArray(document.layers)) return ['Document layers must be an array.'];
  const aidaCount: unknown = document.settings?.aidaCount;
  if (typeof aidaCount !== 'number' || !Number.isFinite(aidaCount) || aidaCount <= 0) errors.push('Document aidaCount must be a finite number greater than zero.');
  if (!Number.isSafeInteger(document.nextLayerId) || document.nextLayerId < 1) errors.push('nextLayerId is invalid.');

  const layerIds = new Set<number>();
  const counts: Record<LayerType, number> = { [LayerType.Stitch]: 0, [LayerType.Specialty]: 0 };
  let seenSpecialty = false;
  let layersValid = true;
  for (const layer of document.layers) {
    const label = `Layer ${String(layer?.id)}`;
    if (!layer || typeof layer !== 'object') {
      errors.push('Layers must be objects.');
      layersValid = false;
      continue;
    }
    if (!Number.isSafeInteger(layer.id) || layer.id < 1 || layerIds.has(layer.id)) errors.push(`${label} has an invalid or duplicated id.`);
    else if (Number.isSafeInteger(document.nextLayerId) && layer.id >= document.nextLayerId) errors.push(`${label} id must be below nextLayerId.`);
    layerIds.add(layer.id);
    if (typeof layer.name !== 'string' || Array.from(layer.name).length < 1 || Array.from(layer.name).length > MAX_LAYER_NAME_CHARS) errors.push(`${label} name must be 1 to ${String(MAX_LAYER_NAME_CHARS)} characters.`);
    if (typeof layer.visible !== 'boolean') errors.push(`${label} must have a boolean visible flag.`);
    if (layer.type === LayerType.Stitch) {
      if (seenSpecialty) errors.push(`${label} is a stitch layer above a specialty layer.`);
      counts[LayerType.Stitch] += 1;
      if (!(layer.kind instanceof Uint8Array) || layer.kind.length !== cellCount) { errors.push(`${label} kind must be a Uint8Array with one value per cell.`); layersValid = false; }
      if (!(layer.colors instanceof Uint16Array) || layer.colors.length !== cellCount * 4) { errors.push(`${label} colors must be a Uint16Array with four slots per cell.`); layersValid = false; }
      if (!(layer.completed instanceof Uint8Array) || layer.completed.length !== cellCount) { errors.push(`${label} completed must be a Uint8Array with one value per cell.`); layersValid = false; }
    } else if (layer.type === LayerType.Specialty) {
      seenSpecialty = true;
      counts[LayerType.Specialty] += 1;
      if (!layer.backstitches || typeof layer.backstitches !== 'object') { errors.push(`${label} backstitches are invalid.`); layersValid = false; }
    } else {
      errors.push(`${label} has an unknown type.`);
      layersValid = false;
    }
  }
  for (const type of [LayerType.Stitch, LayerType.Specialty]) {
    if (counts[type] > MAX_LAYERS_PER_TYPE) errors.push(`A pattern can have at most ${String(MAX_LAYERS_PER_TYPE)} ${type} layers.`);
  }
  if (!layersValid || layerIds.size !== document.layers.length) return errors;

  // Catalog, palette, settings and counters are checked once on a bare surface; each layer then checks its own content.
  const seen = new Set(errors);
  const add = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    errors.push(message);
  };
  const planes = zeroPlanes(document.width, document.height);
  const bare: PatternDocument = { version: DOCUMENT_SCHEMA_VERSION, catalog: document.catalog, width: document.width, height: document.height, kind: planes.kind, colors: planes.colors, completed: planes.completed, backstitches: emptyBackstitches(), palette: document.palette, settings: document.settings, revision: document.revision, nextBackstitchId: document.nextBackstitchId, nextPaletteId: document.nextPaletteId, ...canvasFields(document) };
  collectValidationErrors(bare).forEach(add);
  const backstitchIds = new Set<number>();
  for (const layer of document.layers) {
    for (const message of collectValidationErrors(layerSurface(document, layer.id))) add(`Layer ${String(layer.id)}: ${message}`);
    if (layer.type !== LayerType.Specialty) continue;
    for (const id of layer.backstitches.ids) {
      if (backstitchIds.has(id)) add(`Backstitch ID ${String(id)} is used by more than one layer.`);
      backstitchIds.add(id);
    }
  }
  return errors;
}

export function validateLayeredDocument(document: LayeredDocument): boolean {
  return collectLayeredValidationErrors(document).length === 0;
}

export function assertValidLayeredDocument(document: LayeredDocument): void {
  const errors = collectLayeredValidationErrors(document);
  if (errors.length > 0) throw new DomainError('invalid-document', errors.join(' '));
}

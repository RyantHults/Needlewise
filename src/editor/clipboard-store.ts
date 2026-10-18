import { clonePaletteEntry, clonePatternFragment, type LayerType, type PaletteEntry, type PatternFragment } from '../domain';
import type { CellRect } from './contracts';
import type { SelectionBoundarySegment } from './lasso';

/**
 * The editor clipboard. It lives at module level, in memory only, so it
 * outlives each EditorSurfaceController: the app mounts a new one per project,
 * and a copy in one pattern must paste into the next. A reload loses it.
 */

export interface ClipboardSelectionGeometry {
  readonly kind: 'rect' | 'sparse';
  readonly rect: CellRect;
  readonly boundaries?: readonly SelectionBoundarySegment[];
}

export interface ClipboardEntry {
  readonly fragment: PatternFragment;
  readonly selection: ClipboardSelectionGeometry;
  /** The layer type the copy came from; it decides where a paste lands. */
  readonly layerType: LayerType | undefined;
  /** The source palette entries the fragment uses, so a paste into another pattern can match or create them. */
  readonly palette: readonly PaletteEntry[];
}

let current: ClipboardEntry | undefined;
const listeners = new Set<() => void>();

function cloneEntry(entry: ClipboardEntry): ClipboardEntry {
  return {
    fragment: clonePatternFragment(entry.fragment),
    selection: entry.selection,
    layerType: entry.layerType,
    palette: entry.palette.map(clonePaletteEntry)
  };
}

export function readClipboard(): ClipboardEntry | undefined {
  return current ? cloneEntry(current) : undefined;
}

export function writeClipboard(entry: ClipboardEntry): void {
  current = cloneEntry(entry);
  listeners.forEach((listener) => listener());
}

/** Empties the clipboard; tests call it so one case's copy never leaks into the next. */
export function clearClipboard(): void {
  if (!current) return;
  current = undefined;
  listeners.forEach((listener) => listener());
}

export function subscribeClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

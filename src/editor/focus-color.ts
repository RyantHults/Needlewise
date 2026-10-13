import { CellKind, isThreeQuarterPairKind, type PatternDocument, type PatternFragment } from '../domain';

/** Empty, or every occupied component of the cell at `index` is `focus`. */
function occupiedAllFocus(kind: Uint8Array, colors: Uint16Array, index: number, focus: number): boolean {
  const cellKind = kind[index];
  if (cellKind === CellKind.Empty) return true;
  const offset = index * 4;
  if (cellKind === CellKind.Quarters || isThreeQuarterPairKind(cellKind)) {
    for (let slot = 0; slot < 4; slot += 1) {
      const color = colors[offset + slot];
      if (color !== 0 && color !== focus) return false;
    }
    return true;
  }
  return colors[offset] === focus;
}

/** Empty, or every occupied component is `focus`. */
export function cellEditableUnderFocus(surface: PatternDocument, index: number, focus: number): boolean {
  return occupiedAllFocus(surface.kind, surface.colors, index, focus);
}

/** For component erase: the component at `corner` (slot) is `focus`, or the cell is editable as a whole. */
export function componentEditableUnderFocus(surface: PatternDocument, index: number, corner: number, focus: number): boolean {
  if (cellEditableUnderFocus(surface, index, focus)) return true;
  return isThreeQuarterPairKind(surface.kind[index]) && surface.colors[index * 4 + corner] === focus;
}

/** Keep editable indices; preserves order; returns the same array when nothing is dropped. */
export function filterEditableIndices(surface: PatternDocument, indices: Uint32Array, focus: number): Uint32Array {
  const kept = indices.filter((index) => cellEditableUnderFocus(surface, index, focus));
  return kept.length === indices.length ? indices : kept;
}

/** Non-empty cells whose every occupied component is `focus` (selection content under focus). */
export function focusColorIndices(surface: PatternDocument, indices: Uint32Array, focus: number): Uint32Array {
  return indices.filter((index) => surface.kind[index] !== CellKind.Empty && cellEditableUnderFocus(surface, index, focus));
}

/** Backstitch storage colour lookup by stable id; undefined when missing. */
export function backstitchColor(surface: PatternDocument, id: number): number | undefined {
  const position = surface.backstitches.ids.indexOf(id);
  return position < 0 ? undefined : surface.backstitches.colors[position];
}

/** Keep ids whose backstitch colour is `focus`. */
export function focusBackstitchIds(surface: PatternDocument, ids: readonly number[] | Uint32Array, focus: number): number[] {
  return Array.from(ids).filter((id) => backstitchColor(surface, id) === focus);
}

/** Copy of `fragment` with non-focus cells/backstitches removed, and cells landing on protected destination cells removed. */
export function focusPasteFragment(
  fragment: PatternFragment,
  surface: PatternDocument,
  destination: { x: number; y: number },
  focus: number
): PatternFragment {
  const kind = fragment.kind.slice();
  const colors = fragment.colors.slice();
  for (let y = 0; y < fragment.height; y += 1) {
    for (let x = 0; x < fragment.width; x += 1) {
      const index = y * fragment.width + x;
      if (kind[index] === CellKind.Empty) continue;
      const targetX = destination.x + x;
      const targetY = destination.y + y;
      const inBounds = targetX >= 0 && targetY >= 0 && targetX < surface.width && targetY < surface.height;
      const keep = occupiedAllFocus(kind, colors, index, focus)
        && (!inBounds || cellEditableUnderFocus(surface, targetY * surface.width + targetX, focus));
      if (keep) continue;
      kind[index] = CellKind.Empty;
      colors.fill(0, index * 4, index * 4 + 4);
    }
  }
  const source = fragment.backstitches;
  const keptLines: number[] = [];
  for (let line = 0; line < source.colors.length; line += 1) if (source.colors[line] === focus) keptLines.push(line);
  return {
    version: fragment.version,
    width: fragment.width,
    height: fragment.height,
    kind,
    colors,
    backstitches: {
      x1: Uint32Array.from(keptLines, (line) => source.x1[line]),
      y1: Uint32Array.from(keptLines, (line) => source.y1[line]),
      x2: Uint32Array.from(keptLines, (line) => source.x2[line]),
      y2: Uint32Array.from(keptLines, (line) => source.y2[line]),
      colors: Uint16Array.from(keptLines, (line) => source.colors[line])
    }
  };
}

/** True when moving `selectionIndices` by (dx, dy) would write over a protected cell (cells vacated by the move count as editable). */
export function moveOverwritesProtected(
  surface: PatternDocument,
  selectionIndices: Uint32Array,
  dx: number,
  dy: number,
  focus: number
): boolean {
  const selected = new Set<number>(selectionIndices);
  for (const index of selectionIndices) {
    const x = (index % surface.width) + dx;
    const y = Math.floor(index / surface.width) + dy;
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) continue;
    const target = y * surface.width + x;
    if (selected.has(target)) continue;
    if (!cellEditableUnderFocus(surface, target, focus)) return true;
  }
  return false;
}

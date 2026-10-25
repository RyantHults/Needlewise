import {
  CellKind,
  DomainError,
  FIXED_POINT_UNITS_PER_CELL,
  MAX_PERSISTABLE_CELL_COUNT,
  PATTERN_FRAGMENT_VERSION,
  type CropRect,
  type FragmentSelection,
  type PatternDocument,
  type PatternFragment,
  type PatternFragmentBackstitches
} from './types';
import { assertStrictlyIncreasing, isRecord } from './guards';
import { segmentKey, type BackstitchEndpoints } from './backstitch-store';
import { assertValidDocument } from './validation';
import { isThreeQuarterKind, isThreeQuarterPairKind } from './model';

function cellCount(width: number, height: number): number | undefined {
  const count = width * height;
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_PERSISTABLE_CELL_COUNT ? count : undefined;
}

function containsCellIndex(indices: Uint32Array, target: number): boolean {
  let low = 0;
  let high = indices.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = indices[middle];
    if (candidate === target) return true;
    if (candidate < target) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * Returns whether a fixed-point coordinate is in the closed union of the
 * selected cell squares. Boundary coordinates intentionally test both
 * adjacent cells, so a shared selected boundary belongs to the selection.
 */
export function isFixedPointContainedInCellUnion(
  x: number,
  y: number,
  documentWidth: number,
  documentHeight: number,
  indices: Uint32Array
): boolean {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x > documentWidth * FIXED_POINT_UNITS_PER_CELL || y > documentHeight * FIXED_POINT_UNITS_PER_CELL) return false;
  const units = FIXED_POINT_UNITS_PER_CELL;
  const cellX = Math.floor(x / units);
  const cellY = Math.floor(y / units);
  const xCandidates = x % units === 0 ? [cellX - 1, cellX] : [cellX];
  const yCandidates = y % units === 0 ? [cellY - 1, cellY] : [cellY];
  for (const candidateY of yCandidates) {
    if (candidateY < 0 || candidateY >= documentHeight) continue;
    for (const candidateX of xCandidates) {
      if (candidateX < 0 || candidateX >= documentWidth) continue;
      if (containsCellIndex(indices, candidateY * documentWidth + candidateX)) return true;
    }
  }
  return false;
}

/** Shared endpoint containment rule for sparse fragment capture and deletion. */
export function backstitchEndpointsContainedInCellUnion(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  documentWidth: number,
  documentHeight: number,
  indices: Uint32Array
): boolean {
  return isFixedPointContainedInCellUnion(x1, y1, documentWidth, documentHeight, indices)
    && isFixedPointContainedInCellUnion(x2, y2, documentWidth, documentHeight, indices);
}

function fragmentBackstitches(value: unknown): value is PatternFragmentBackstitches {
  if (!isRecord(value)) return false;
  return value.x1 instanceof Uint32Array
    && value.y1 instanceof Uint32Array
    && value.x2 instanceof Uint32Array
    && value.y2 instanceof Uint32Array
    && value.colors instanceof Uint16Array;
}

export function getPatternFragmentValidationErrors(fragment: PatternFragment): string[] {
  const errors: string[] = [];
  if (!isRecord(fragment) || fragment.version !== PATTERN_FRAGMENT_VERSION) {
    errors.push('Pattern fragment version must be 1.');
    return errors;
  }
  if (!Number.isSafeInteger(fragment.width) || !Number.isSafeInteger(fragment.height) || fragment.width < 1 || fragment.height < 1) {
    errors.push('Pattern fragment dimensions must be positive integers.');
    return errors;
  }
  const count = cellCount(fragment.width, fragment.height);
  if (count === undefined) {
    errors.push('Pattern fragment dimensions are too large.');
    return errors;
  }
  if (!(fragment.kind instanceof Uint8Array) || fragment.kind.length !== count) errors.push('Pattern fragment kind must be a Uint8Array with one value per cell.');
  if (!(fragment.colors instanceof Uint16Array) || fragment.colors.length !== count * 4) errors.push('Pattern fragment colors must be a Uint16Array with four slots per cell.');
  if (!fragmentBackstitches(fragment.backstitches)) {
    errors.push('Pattern fragment backstitches must contain typed coordinate and color arrays.');
    return errors;
  }
  const stores = [fragment.backstitches.x1, fragment.backstitches.y1, fragment.backstitches.x2, fragment.backstitches.y2, fragment.backstitches.colors];
  if (stores.some((store) => store.length !== fragment.backstitches.x1.length)) errors.push('Pattern fragment backstitch arrays must have equal lengths.');
  if (errors.length > 0) return errors;

  for (let index = 0; index < count; index += 1) {
    const kind = fragment.kind[index];
    const offset = index * 4;
    if (![CellKind.Empty, CellKind.Full, CellKind.HalfBackslash, CellKind.HalfSlash, CellKind.Quarters].some((value) => value === kind) && !isThreeQuarterKind(kind) && !isThreeQuarterPairKind(kind)) {
      errors.push(`Pattern fragment cell ${String(index)} has an unknown kind.`);
      continue;
    }
    if (kind === CellKind.Empty) {
      if (fragment.colors[offset] !== 0 || fragment.colors[offset + 1] !== 0 || fragment.colors[offset + 2] !== 0 || fragment.colors[offset + 3] !== 0) errors.push(`Empty pattern fragment cell ${String(index)} contains color data.`);
    } else if (isThreeQuarterPairKind(kind)) {
      const occupiedMask = [0, 1, 2, 3].reduce((mask, slot) => mask | (fragment.colors[offset + slot] === 0 ? 0 : 1 << slot), 0);
      if (occupiedMask !== 0b0101 && occupiedMask !== 0b1010) errors.push(`Three-quarter pair fragment cell ${String(index)} must contain exactly one opposite occupied pair.`);
    } else if (kind === CellKind.Full || kind === CellKind.HalfBackslash || kind === CellKind.HalfSlash || isThreeQuarterKind(kind)) {
      if (fragment.colors[offset] === 0 || fragment.colors[offset + 1] !== 0 || fragment.colors[offset + 2] !== 0 || fragment.colors[offset + 3] !== 0) errors.push(`Pattern fragment cell ${String(index)} has invalid non-quarter color data.`);
    } else if (fragment.colors[offset] === 0 && fragment.colors[offset + 1] === 0 && fragment.colors[offset + 2] === 0 && fragment.colors[offset + 3] === 0) {
      errors.push(`Pattern fragment quarter cell ${String(index)} must contain at least one color.`);
    }
  }

  const maxX = fragment.width * 4;
  const maxY = fragment.height * 4;
  const segments = new Set<string>();
  for (let index = 0; index < fragment.backstitches.x1.length; index += 1) {
    const x1 = fragment.backstitches.x1[index];
    const y1 = fragment.backstitches.y1[index];
    const x2 = fragment.backstitches.x2[index];
    const y2 = fragment.backstitches.y2[index];
    const key = segmentKey(fragment.backstitches, index);
    if (x1 > maxX || x2 > maxX || y1 > maxY || y2 > maxY) errors.push(`Pattern fragment backstitch ${String(index)} is outside the fragment boundary.`);
    if (x1 === x2 && y1 === y2) errors.push(`Pattern fragment backstitch ${String(index)} has identical endpoints.`);
    if (x1 > x2 || (x1 === x2 && y1 > y2)) errors.push(`Pattern fragment backstitch ${String(index)} endpoints are not canonical.`);
    if (fragment.backstitches.colors[index] === 0) errors.push(`Pattern fragment backstitch ${String(index)} has no palette color.`);
    if (segments.has(key)) errors.push(`Pattern fragment backstitch ${String(index)} duplicates another segment.`);
    segments.add(key);
  }
  return errors;
}

export function assertValidPatternFragment(fragment: PatternFragment): void {
  const errors = getPatternFragmentValidationErrors(fragment);
  if (errors.length > 0) throw new DomainError('invalid-fragment', errors.join(' '));
}

function rectInside(rect: CropRect, width: number, height: number): boolean {
  return Number.isSafeInteger(rect.x) && Number.isSafeInteger(rect.y) && Number.isSafeInteger(rect.width) && Number.isSafeInteger(rect.height)
    && rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1 && rect.x + rect.width <= width && rect.y + rect.height <= height;
}

function validateSelection(document: PatternDocument, selection: CropRect): void {
  if (!isRecord(selection) || !rectInside(selection, document.width, document.height)) {
    throw new DomainError('invalid-selection', 'Fragment selection must be a non-empty rectangle inside the document.');
  }
}

/** The cell planes of `rect` in a row-major source `width` cells wide. */
function copyCellRows(source: Pick<PatternFragment, 'width' | 'kind' | 'colors'>, rect: CropRect): Pick<PatternFragment, 'kind' | 'colors'> {
  const kind = new Uint8Array(rect.width * rect.height);
  const colors = new Uint16Array(kind.length * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = (rect.y + y) * source.width + rect.x;
    kind.set(source.kind.subarray(from, from + rect.width), y * rect.width);
    colors.set(source.colors.subarray(from * 4, (from + rect.width) * 4), y * rect.width * 4);
  }
  return { kind, colors };
}

type SegmentContains = (x1: number, y1: number, x2: number, y2: number) => boolean;

/** Whether both endpoints lie in `rect` (cells), edges included. */
function segmentInRect(rect: CropRect): SegmentContains {
  const left = rect.x * FIXED_POINT_UNITS_PER_CELL;
  const top = rect.y * FIXED_POINT_UNITS_PER_CELL;
  const right = (rect.x + rect.width) * FIXED_POINT_UNITS_PER_CELL;
  const bottom = (rect.y + rect.height) * FIXED_POINT_UNITS_PER_CELL;
  return (x1, y1, x2, y2) => x1 >= left && x1 <= right && x2 >= left && x2 <= right && y1 >= top && y1 <= bottom && y2 >= top && y2 <= bottom;
}

/** Storage positions of the backstitches `contains` accepts, in storage order. */
export function containedBackstitchPositions(store: BackstitchEndpoints, contains: SegmentContains): number[] {
  const positions: number[] = [];
  for (let index = 0; index < store.x1.length; index += 1) if (contains(store.x1[index], store.y1[index], store.x2[index], store.y2[index])) positions.push(index);
  return positions;
}

/** The lines at `positions`, moved so (`left`, `top`) in fixed-point units becomes the origin. */
export function rebaseBackstitches(store: PatternFragmentBackstitches, positions: readonly number[], left: number, top: number): PatternFragmentBackstitches {
  return {
    x1: Uint32Array.from(positions, (index) => store.x1[index] - left),
    y1: Uint32Array.from(positions, (index) => store.y1[index] - top),
    x2: Uint32Array.from(positions, (index) => store.x2[index] - left),
    y2: Uint32Array.from(positions, (index) => store.y2[index] - top),
    colors: Uint16Array.from(positions, (index) => store.colors[index])
  };
}

export function createPatternFragment(document: PatternDocument, selection: FragmentSelection): PatternFragment {
  assertValidDocument(document);
  if ('kind' in selection && selection.kind === 'sparse') return createPatternFragmentFromCells(document, selection.indices);
  const rect = 'kind' in selection ? selection.rect : selection;
  validateSelection(document, rect);
  const { kind, colors } = copyCellRows(document, rect);
  const positions = containedBackstitchPositions(document.backstitches, segmentInRect(rect));
  const backstitches = rebaseBackstitches(document.backstitches, positions, rect.x * FIXED_POINT_UNITS_PER_CELL, rect.y * FIXED_POINT_UNITS_PER_CELL);
  return { version: PATTERN_FRAGMENT_VERSION, width: rect.width, height: rect.height, kind, colors, backstitches };
}

function validateCellSetSelection(document: PatternDocument, indices: Uint32Array): void {
  if (!(indices instanceof Uint32Array) || indices.length === 0) throw new DomainError('invalid-cell-set', 'Cell selection indices must be a non-empty Uint32Array.');
  assertStrictlyIncreasing(indices, 'invalid-cell-set', 'Cell selection indices', document.kind.length);
}

/** Capture a sparse selection into the existing transparent v1 fragment format. */
export function createPatternFragmentFromCells(document: PatternDocument, indices: Uint32Array): PatternFragment {
  assertValidDocument(document);
  validateCellSetSelection(document, indices);

  let minX = document.width;
  let minY = document.height;
  let maxX = -1;
  let maxY = -1;
  for (const index of indices) {
    const x = index % document.width;
    const y = Math.floor(index / document.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const count = width * height;
  const kind = new Uint8Array(count);
  const colors = new Uint16Array(count * 4);
  for (const index of indices) {
    const sourceX = index % document.width;
    const sourceY = Math.floor(index / document.width);
    const targetIndex = (sourceY - minY) * width + sourceX - minX;
    kind[targetIndex] = document.kind[index];
    colors.set(document.colors.subarray(index * 4, index * 4 + 4), targetIndex * 4);
  }

  const positions = containedBackstitchPositions(document.backstitches, (x1, y1, x2, y2) => backstitchEndpointsContainedInCellUnion(x1, y1, x2, y2, document.width, document.height, indices));
  const backstitches = rebaseBackstitches(document.backstitches, positions, minX * FIXED_POINT_UNITS_PER_CELL, minY * FIXED_POINT_UNITS_PER_CELL);
  return { version: PATTERN_FRAGMENT_VERSION, width, height, kind, colors, backstitches };
}

export function clonePatternFragment(fragment: PatternFragment): PatternFragment {
  assertValidPatternFragment(fragment);
  return {
    version: PATTERN_FRAGMENT_VERSION,
    width: fragment.width,
    height: fragment.height,
    kind: fragment.kind.slice(),
    colors: fragment.colors.slice(),
    backstitches: {
      x1: fragment.backstitches.x1.slice(),
      y1: fragment.backstitches.y1.slice(),
      x2: fragment.backstitches.x2.slice(),
      y2: fragment.backstitches.y2.slice(),
      colors: fragment.backstitches.colors.slice()
    }
  };
}

/** Keeps the cells in `rect` (fragment coordinates) and the backstitches wholly inside it, rebased to the origin. */
export function cropPatternFragment(fragment: PatternFragment, rect: CropRect): PatternFragment {
  assertValidPatternFragment(fragment);
  if (!rectInside(rect, fragment.width, fragment.height)) {
    throw new DomainError('invalid-selection', 'Fragment crop must be a non-empty rectangle inside the fragment.');
  }
  const { kind, colors } = copyCellRows(fragment, rect);
  const positions = containedBackstitchPositions(fragment.backstitches, segmentInRect(rect));
  const backstitches = rebaseBackstitches(fragment.backstitches, positions, rect.x * FIXED_POINT_UNITS_PER_CELL, rect.y * FIXED_POINT_UNITS_PER_CELL);
  return { version: PATTERN_FRAGMENT_VERSION, width: rect.width, height: rect.height, kind, colors, backstitches };
}

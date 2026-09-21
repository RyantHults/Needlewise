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
import { assertValidDocument } from './validation';
import { isThreeQuarterKind, isThreeQuarterPairKind } from './model';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cellCount(width: number, height: number): number | undefined {
  const count = width * height;
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_PERSISTABLE_CELL_COUNT ? count : undefined;
}

function segmentKey(x1: number, y1: number, x2: number, y2: number): string {
  return `${String(x1)},${String(y1)},${String(x2)},${String(y2)}`;
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
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > documentWidth * FIXED_POINT_UNITS_PER_CELL || y > documentHeight * FIXED_POINT_UNITS_PER_CELL) return false;
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
  if (!isObject(value)) return false;
  return value.x1 instanceof Uint32Array
    && value.y1 instanceof Uint32Array
    && value.x2 instanceof Uint32Array
    && value.y2 instanceof Uint32Array
    && value.colors instanceof Uint16Array;
}

export function getPatternFragmentValidationErrors(fragment: PatternFragment): string[] {
  const errors: string[] = [];
  if (!isObject(fragment) || fragment.version !== PATTERN_FRAGMENT_VERSION) {
    errors.push('Pattern fragment version must be 1.');
    return errors;
  }
  if (!Number.isInteger(fragment.width) || !Number.isInteger(fragment.height) || fragment.width < 1 || fragment.height < 1) {
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
    const key = segmentKey(x1, y1, x2, y2);
    if (x1 > maxX || x2 > maxX || y1 > maxY || y2 > maxY) errors.push(`Pattern fragment backstitch ${String(index)} is outside the fragment boundary.`);
    if (x1 === x2 && y1 === y2) errors.push(`Pattern fragment backstitch ${String(index)} has identical endpoints.`);
    if (x1 > x2 || (x1 === x2 && y1 > y2)) errors.push(`Pattern fragment backstitch ${String(index)} endpoints are not canonical.`);
    if (fragment.backstitches.colors[index] === 0) errors.push(`Pattern fragment backstitch ${String(index)} has no palette color.`);
    if (segments.has(key)) errors.push(`Pattern fragment backstitch ${String(index)} duplicates another segment.`);
    segments.add(key);
  }
  return errors;
}

export function validatePatternFragment(fragment: PatternFragment): boolean {
  return getPatternFragmentValidationErrors(fragment).length === 0;
}

export function assertValidPatternFragment(fragment: PatternFragment): void {
  const errors = getPatternFragmentValidationErrors(fragment);
  if (errors.length > 0) throw new DomainError('invalid-fragment', errors.join(' '));
}

export const assertFragmentValid = assertValidPatternFragment;

function validateSelection(document: PatternDocument, selection: CropRect): void {
  if (!isObject(selection) || !Number.isInteger(selection.x) || !Number.isInteger(selection.y) || !Number.isInteger(selection.width) || !Number.isInteger(selection.height) || selection.x < 0 || selection.y < 0 || selection.width < 1 || selection.height < 1 || selection.x + selection.width > document.width || selection.y + selection.height > document.height) {
    throw new DomainError('invalid-selection', 'Fragment selection must be a non-empty rectangle inside the document.');
  }
}

export function createPatternFragment(document: PatternDocument, selection: FragmentSelection): PatternFragment {
  assertValidDocument(document);
  if ('kind' in selection && selection.kind === 'sparse') return createPatternFragmentFromCells(document, selection.indices);
  const rect = 'kind' in selection ? selection.rect : selection;
  validateSelection(document, rect);
  const count = rect.width * rect.height;
  const kind = new Uint8Array(count);
  const colors = new Uint16Array(count * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const sourceCellOffset = (rect.y + y) * document.width + rect.x;
    const targetCellOffset = y * rect.width;
    kind.set(document.kind.subarray(sourceCellOffset, sourceCellOffset + rect.width), targetCellOffset);
    const sourceColorOffset = sourceCellOffset * 4;
    const targetColorOffset = targetCellOffset * 4;
    colors.set(document.colors.subarray(sourceColorOffset, sourceColorOffset + rect.width * 4), targetColorOffset);
  }

  const left = rect.x * 4;
  const top = rect.y * 4;
  const right = (rect.x + rect.width) * 4;
  const bottom = (rect.y + rect.height) * 4;
  let containedCount = 0;
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    const store = document.backstitches;
    if (store.x1[index] >= left && store.x1[index] <= right && store.x2[index] >= left && store.x2[index] <= right && store.y1[index] >= top && store.y1[index] <= bottom && store.y2[index] >= top && store.y2[index] <= bottom) containedCount += 1;
  }
  const backstitches: PatternFragmentBackstitches = {
    x1: new Uint32Array(containedCount),
    y1: new Uint32Array(containedCount),
    x2: new Uint32Array(containedCount),
    y2: new Uint32Array(containedCount),
    colors: new Uint16Array(containedCount)
  };
  let targetIndex = 0;
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    const store = document.backstitches;
    if (!(store.x1[index] >= left && store.x1[index] <= right && store.x2[index] >= left && store.x2[index] <= right && store.y1[index] >= top && store.y1[index] <= bottom && store.y2[index] >= top && store.y2[index] <= bottom)) continue;
    backstitches.x1[targetIndex] = store.x1[index] - left;
    backstitches.y1[targetIndex] = store.y1[index] - top;
    backstitches.x2[targetIndex] = store.x2[index] - left;
    backstitches.y2[targetIndex] = store.y2[index] - top;
    backstitches.colors[targetIndex] = store.colors[index];
    targetIndex += 1;
  }
  return { version: PATTERN_FRAGMENT_VERSION, width: rect.width, height: rect.height, kind, colors, backstitches };
}

function validateCellSetSelection(document: PatternDocument, indices: Uint32Array): void {
  if (!(indices instanceof Uint32Array) || indices.length === 0) throw new DomainError('invalid-cell-set', 'Cell selection indices must be a non-empty Uint32Array.');
  let previous = -1;
  for (const index of indices) {
    if (index <= previous) throw new DomainError('invalid-cell-set', 'Cell selection indices must be strictly increasing and unique.');
    if (index >= document.kind.length) throw new DomainError('out-of-bounds', `Cell selection index ${String(index)} is out of bounds.`);
    previous = index;
  }
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

  let containedCount = 0;
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    const store = document.backstitches;
    if (backstitchEndpointsContainedInCellUnion(store.x1[index], store.y1[index], store.x2[index], store.y2[index], document.width, document.height, indices)) containedCount += 1;
  }
  const backstitches: PatternFragmentBackstitches = {
    x1: new Uint32Array(containedCount),
    y1: new Uint32Array(containedCount),
    x2: new Uint32Array(containedCount),
    y2: new Uint32Array(containedCount),
    colors: new Uint16Array(containedCount)
  };
  const left = minX * FIXED_POINT_UNITS_PER_CELL;
  const top = minY * FIXED_POINT_UNITS_PER_CELL;
  let targetIndex = 0;
  for (let index = 0; index < document.backstitches.ids.length; index += 1) {
    const store = document.backstitches;
    if (!backstitchEndpointsContainedInCellUnion(store.x1[index], store.y1[index], store.x2[index], store.y2[index], document.width, document.height, indices)) continue;
    backstitches.x1[targetIndex] = store.x1[index] - left;
    backstitches.y1[targetIndex] = store.y1[index] - top;
    backstitches.x2[targetIndex] = store.x2[index] - left;
    backstitches.y2[targetIndex] = store.y2[index] - top;
    backstitches.colors[targetIndex] = store.colors[index];
    targetIndex += 1;
  }
  return { version: PATTERN_FRAGMENT_VERSION, width, height, kind, colors, backstitches };
}

export const copyPatternFragment = createPatternFragment;
export const createFragment = createPatternFragment;
export const capturePatternFragment = createPatternFragment;
export const capturePatternFragmentFromCells = createPatternFragmentFromCells;
export const createSparsePatternFragment = createPatternFragmentFromCells;
export const copyPatternFragmentFromCells = createPatternFragmentFromCells;

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

export function readPatternFragmentCell(fragment: PatternFragment, x: number, y: number): { x: number; y: number; kind: CellKind; colors: Uint16Array } {
  assertValidPatternFragment(fragment);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= fragment.width || y >= fragment.height) throw new DomainError('out-of-bounds', `Fragment cell (${String(x)}, ${String(y)}) is out of bounds.`);
  const offset = (y * fragment.width + x) * 4;
  return { x, y, kind: fragment.kind[y * fragment.width + x] as CellKind, colors: fragment.colors.slice(offset, offset + 4) };
}

export const getPatternFragmentCell = readPatternFragmentCell;
export const readFragmentCell = readPatternFragmentCell;

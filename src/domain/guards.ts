import { DomainError } from './types';

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireCommandInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DomainError('invalid-command', `${label} must be an integer.`);
  }
  return value;
}

/**
 * Throws `code` unless `values` strictly increase, which also makes them
 * unique. With `limit`, a value at or past it throws `out-of-bounds`.
 */
export function assertStrictlyIncreasing(values: ArrayLike<number>, code: string, label: string, limit?: number): void {
  let previous = -1;
  for (let position = 0; position < values.length; position += 1) {
    const value = values[position];
    if (value <= previous) throw new DomainError(code, `${label} must be strictly increasing and unique.`);
    if (limit !== undefined && value >= limit) throw new DomainError('out-of-bounds', `${label} include ${String(value)}, which is out of bounds.`);
    previous = value;
  }
}

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

const FORWARD: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowRight'],
  vertical: ['ArrowDown'],
  both: ['ArrowRight', 'ArrowDown']
};
const BACKWARD: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowLeft'],
  vertical: ['ArrowUp'],
  both: ['ArrowLeft', 'ArrowUp']
};

/** The index a roving-focus group moves to for `key`, wrapping at the ends; null when the key is not one of its keys. Home and End always jump to the first and last. */
export function nextRovingIndex(key: string, index: number, length: number, orientation: RovingOrientation): number | null {
  if (length <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (FORWARD[orientation].includes(key)) return (index + 1) % length;
  if (BACKWARD[orientation].includes(key)) return (index - 1 + length) % length;
  return null;
}

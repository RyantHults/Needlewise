import type { ModelPoint } from './contracts';

export type CellPoint = ModelPoint;

function point(x: number, y: number): CellPoint {
  return { x, y };
}

/**
 * Enumerate every grid cell touched by a line between cell centres. When the
 * line crosses a grid corner both side cells are included before the diagonal
 * cell, preventing fast pointer samples from leaving gaps.
 */
export function supercoverLine(start: CellPoint, end: CellPoint): CellPoint[] {
  const cells: CellPoint[] = [];
  const add = (x: number, y: number): void => {
    const previous = cells[cells.length - 1];
    if (!previous || previous.x !== x || previous.y !== y) cells.push(point(x, y));
  };
  let x = Math.floor(start.x);
  let y = Math.floor(start.y);
  const targetX = Math.floor(end.x);
  const targetY = Math.floor(end.y);
  add(x, y);
  const deltaX = Math.abs(targetX - x);
  const deltaY = Math.abs(targetY - y);
  if (deltaX === 0 && deltaY === 0) return cells;
  const stepX = targetX >= x ? 1 : -1;
  const stepY = targetY >= y ? 1 : -1;
  let crossedX = 0;
  let crossedY = 0;
  while (x !== targetX || y !== targetY) {
    // Compare the next vertical and horizontal boundary crossings as integer
    // products. This is the exact cross-product form of a supercover walk and
    // does not accumulate floating-point boundary errors on steep lines.
    const xCrossing = (2 * crossedX + 1) * deltaY;
    const yCrossing = (2 * crossedY + 1) * deltaX;
    if (xCrossing < yCrossing) {
      x += stepX;
      crossedX += 1;
      add(x, y);
    } else if (yCrossing < xCrossing) {
      y += stepY;
      crossedY += 1;
      add(x, y);
    } else {
      // Exact corner crossing: include both cells sharing the corner.
      add(x + stepX, y);
      add(x, y + stepY);
      x += stepX;
      y += stepY;
      crossedX += 1;
      crossedY += 1;
      add(x, y);
    }
  }
  return cells;
}

export const supercover = supercoverLine;
export const interpolateCells = supercoverLine;

export function cellKey(cell: CellPoint): string {
  return `${String(Math.floor(cell.x))}:${String(Math.floor(cell.y))}`;
}

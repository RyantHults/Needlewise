import type { CellRect, ModelPoint } from './contracts';

/**
 * Visit the cells of the deterministic disk stamp anchored on a hit cell,
 * clipped to `bounds`.
 *
 * Brush size is the disk diameter in cell units. An odd size centers the disk
 * on the hit cell's center. An even size centers it on the hit cell's
 * bottom-right corner, so the hit cell is the top-left of the stamp and size 2
 * is a 2x2 square rather than a cross. A cell is included when its center lies
 * within the radius, so a size-1 brush selects exactly the hit cell.
 */
export function brushDisk(center: ModelPoint, size: number, bounds: CellRect, visit: (x: number, y: number) => void): void {
  const cellX = Math.floor(center.x);
  const cellY = Math.floor(center.y);
  const radius = size / 2;
  const radiusSquared = radius * radius;
  const offset = size % 2 === 0 ? 1 : 0.5;
  const cx = cellX + offset;
  const cy = cellY + offset;
  const minX = Math.max(bounds.x, Math.ceil(cx - radius - 0.5));
  const maxX = Math.min(bounds.x + bounds.width - 1, Math.floor(cx + radius - 0.5));
  const minY = Math.max(bounds.y, Math.ceil(cy - radius - 0.5));
  const maxY = Math.min(bounds.y + bounds.height - 1, Math.floor(cy + radius - 0.5));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radiusSquared) visit(x, y);
    }
  }
}

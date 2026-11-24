import type { BeadKind, BeadSize } from "../catalog";

/** "Petite · 15/0 · 2 mm": a size group's heading and filter description. */
export function beadSizeHeading(size: BeadSize): string {
  return `${size.label} · ${size.gauge} · ${size.diameterMm} mm`;
}

/** "Petite Glass · 15/0 · 2 × 1.4 mm": a bead's series and size. */
export function beadKindLabel({ series, size }: BeadKind): string {
  return `${series} · ${size.gauge} · ${size.diameterMm} × ${size.lengthMm} mm`;
}

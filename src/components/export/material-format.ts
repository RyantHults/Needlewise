import type { MaterialEstimate } from '../../domain';
import { number, type LegendLength, type LegendSkeins } from '../../export';

const YARDS_PER_METER = 1.09361;

type Material = MaterialEstimate | Omit<MaterialEstimate, 'paletteId'>;

const range = (min: number, max: number, unit: string) => {
  // Collapse ranges that round identically (e.g. zero-to-zero) to one value.
  const low = number(min);
  const high = number(max);
  return low === high ? `${low} ${unit}` : `${low}–${high} ${unit}`;
};

export const PHYSICAL_ESTIMATE_UNAVAILABLE = 'Physical estimate unavailable';

export function materialLine(material: Material | undefined): string {
  if (!material || material.estimatedMeters === undefined || material.estimatedSkeins === undefined) return PHYSICAL_ESTIMATE_UNAVAILABLE;
  const skeins = material.estimateRange?.skeins;
  return skeins ? range(skeins.min, skeins.max, 'skeins') : `${number(material.estimatedSkeins)} skeins`;
}

export function materialYardage(material: Material | undefined): string | null {
  if (!material || material.estimatedMeters === undefined) return null;
  const meters = material.estimateRange?.meters;
  return meters
    ? range(meters.min * YARDS_PER_METER, meters.max * YARDS_PER_METER, 'yd')
    : `${number(material.estimatedMeters * YARDS_PER_METER)} yd`;
}

export function formatSkeins(skeins: LegendSkeins | undefined): string {
  return skeins ? range(skeins.min, skeins.max, 'skeins') : PHYSICAL_ESTIMATE_UNAVAILABLE;
}

/** A legend length in the display unit it was built for (`m` or `yd`). */
export function formatLength(length: LegendLength | undefined): string | null {
  return length ? range(length.min, length.max, length.unit) : null;
}

export function stitchSummary(counts: { full: number; half: number; quarter: number; threeQuarter?: number; backstitch: number }): string {
  const parts = [
    counts.full > 0 ? `${counts.full} full` : null,
    counts.half > 0 ? `${counts.half} half` : null,
    (counts.threeQuarter ?? 0) > 0 ? `${counts.threeQuarter} 3/4` : null,
    counts.quarter > 0 ? `${counts.quarter} quarter` : null,
    counts.backstitch > 0 ? `${counts.backstitch} backstitch` : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'No stitches';
}

/** A pattern title as a safe PDF filename. */
export function pdfFilename(title: string): string {
  const base = title.replace(/[^\p{L}\p{N}._ -]+/gu, '-').replace(/\s+/g, ' ').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 80);
  return `${base || 'pattern'}.pdf`;
}

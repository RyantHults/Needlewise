/** Stable, locale-independent symbols for palette IDs. */
export function symbolForPaletteId(id: number): string {
  if (!Number.isInteger(id) || id < 1) return '';
  return id.toString(36);
}

export const paletteIdToSymbol = symbolForPaletteId;
export const deterministicPaletteSymbol = symbolForPaletteId;

function byte(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(255, Math.round(parsed))) : undefined;
}

/** Convert common CSS colors to a deterministic luminance gray. */
export function grayscaleColor(color: string): string {
  const input = color.trim();
  let red: number | undefined;
  let green: number | undefined;
  let blue: number | undefined;
  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3) {
      red = Number.parseInt(`${digits[0]}${digits[0]}`, 16);
      green = Number.parseInt(`${digits[1]}${digits[1]}`, 16);
      blue = Number.parseInt(`${digits[2]}${digits[2]}`, 16);
    } else {
      red = Number.parseInt(digits.slice(0, 2), 16);
      green = Number.parseInt(digits.slice(2, 4), 16);
      blue = Number.parseInt(digits.slice(4, 6), 16);
    }
  }
  const rgb = input.match(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/i);
  if (rgb) {
    red = byte(rgb[1]);
    green = byte(rgb[2]);
    blue = byte(rgb[3]);
  }
  if (red === undefined || green === undefined || blue === undefined) return '#808080';
  const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
  const value = luminance.toString(16).padStart(2, '0');
  return `#${value}${value}${value}`;
}

export const toGrayscale = grayscaleColor;

import { DEFAULT_RENDERER_STYLE, type RendererStyle } from '../editor/contracts';

/** The RendererStyle fields that are theme colours, each read from a `--renderer-*` token in styles.css. */
export const RENDERER_COLOR_FIELDS = [
  'backgroundColor',
  'gridColor',
  'midGridColor',
  'majorGridColor',
  'lightStitchGridColor',
  'lightStitchMidGridColor',
  'lightStitchMajorGridColor',
  'darkStitchGridColor',
  'darkStitchMidGridColor',
  'darkStitchMajorGridColor',
  'chartBorderColor',
  'symbolColor',
  'symbolBackgroundColor',
  'completedColor',
  'selectionColor',
  'cursorColor',
  'missingPaletteColor',
  'pendingCellColor',
  'offCanvasColor',
  'ghostGridColor',
  'ghostMajorGridColor',
  'canvasAddColor',
  'canvasRemoveColor',
  'centerMarkColor',
  'highlightOutlineColor',
  'highlightHaloColor'
] as const satisfies readonly (keyof RendererStyle)[];

export type RendererColorField = (typeof RENDERER_COLOR_FIELDS)[number];
export type RendererColors = Pick<RendererStyle, RendererColorField>;

/** `selectionColor` -> `--renderer-selection-color`. */
export function rendererColorToken(field: RendererColorField): string {
  let name = '--renderer-';
  for (const char of field) name += char >= 'A' && char <= 'Z' ? `-${char.toLowerCase()}` : char;
  return name;
}

/**
 * A colour token's current value on the root element, or `fallback` when it is
 * unset, as in jsdom (no stylesheet) or outside a document.
 */
export function readThemeColor(token: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
}

/** The renderer's colours from the theme tokens, each falling back to DEFAULT_RENDERER_STYLE. */
export function readRendererColors(): RendererColors {
  const colors = {} as Record<RendererColorField, string>;
  for (const field of RENDERER_COLOR_FIELDS) colors[field] = readThemeColor(rendererColorToken(field), DEFAULT_RENDERER_STYLE[field]);
  return colors;
}

/**
 * Calls `onChange` whenever the theme can have changed: the system colour
 * scheme flips, or the root element's `data-theme` attribute changes.
 * Returns the unsubscribe.
 */
export function subscribeThemeChange(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  scheme?.addEventListener('change', onChange);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(onChange) : undefined;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    scheme?.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}

/**
 * Live previews for the dev theme editor. A draft is shown by one extra rule
 * on the theme's own selector, appended after every theme stylesheet so it wins
 * at equal specificity, and removed again when the draft is saved or dropped.
 */

const OVERRIDE_ATTRIBUTE = 'data-theme-editor';

/** Replaces the override rule with `selector { name: value; … }`; `declarations` may include `color-scheme`. */
export function applyLiveOverride(selector: string, declarations: Readonly<Record<string, string>>): void {
  let style = document.head.querySelector<HTMLStyleElement>(`style[${OVERRIDE_ATTRIBUTE}]`);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute(OVERRIDE_ATTRIBUTE, '');
  }
  const body = Object.entries(declarations).map(([name, value]) => `  ${name}: ${value};`).join('\n');
  style.textContent = `${selector} {\n${body}\n}`;
  // Re-appending keeps the rule last even after Vite hot-swaps a theme file into <head>.
  document.head.append(style);
  repaintCanvas();
}

export function clearLiveOverride(): void {
  document.head.querySelector(`style[${OVERRIDE_ATTRIBUTE}]`)?.remove();
  repaintCanvas();
}

/**
 * The canvas reads the renderer tokens once per theme change, which
 * `subscribeThemeChange` detects as a `data-theme` mutation. Setting the
 * attribute to its current value still queues a mutation record, so this
 * repaints the canvas without changing the theme.
 */
function repaintCanvas(): void {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme !== null) document.documentElement.setAttribute('data-theme', theme);
}

/** What `property: value` computes to on a hidden probe under `<body>`, read back as each of `longhands`. */
export function probeComputed(property: string, value: string, longhands: readonly string[]): string[] {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.setProperty(property, value);
  document.body.append(probe);
  const computed = getComputedStyle(probe);
  const values = longhands.map((longhand) => computed.getPropertyValue(longhand));
  probe.remove();
  return values;
}

/** A CSS colour value, such as `var(--x)` or a `color-mix()`, as `#RRGGBB`, or '' when the browser cannot draw it. */
export function resolveColor(value: string): string {
  const [computed] = probeComputed('color', value, ['color']);
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context) return '';
  context.canvas.width = 1;
  context.canvas.height = 1;
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** The colour a custom property currently resolves to, as `#RRGGBB`, or ''. */
export const resolveHex = (name: string): string => resolveColor(`var(${name})`);

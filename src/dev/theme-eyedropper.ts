import { probeComputed, resolveColor } from './theme-live';

/**
 * The theme editor's eyedropper: which colour tokens an element paints with.
 *
 * A resolved colour cannot name its token, because many tokens share a value,
 * so this reads the authored rules instead. It collects every declaration that
 * applies to the element and mentions a `--color-*` or `--renderer-*` token,
 * from the matching stylesheet rules and the inline style, and lets the browser
 * break ties: a candidate wins only when the declaration, computed on a probe,
 * equals what the element actually computes for that property. Of several
 * winners the last in document order is kept, since that is the one the cascade
 * would pick among equal values anyway. This avoids reimplementing specificity.
 *
 * A pick is made with the pointer over the element, so the cascade the browser
 * reports is the hover state. The rest state is found by running the same
 * lookup a second time with every state pseudo-class in every rule rewritten to
 * `:not(*)`, "never in that state", and restored before the pick returns. The
 * state pass then adds only what differs from rest.
 *
 * The chart is drawn on canvases, which have no rules to read, so a pick over
 * one reads the pixel instead. Only the canvas chrome is identified, by an exact
 * colour match against the renderer tokens that paint it; pattern contents fall
 * through to the element beneath the canvases.
 */

export type PickCategory = 'canvas' | 'background' | 'text' | 'border' | 'outline' | 'shadow' | 'fill' | 'stroke';

export interface PickedToken {
  readonly category: PickCategory;
  /** The declared property, such as `border-bottom` or `background`; `pixel` for a canvas pick. */
  readonly property: string;
  /** The token the declaration names, then each token it is followed through. */
  readonly chain: readonly string[];
  /** The token the selected theme declares, to jump to; null when only Needlewise defines it. */
  readonly target: string | null;
  /** The ancestor the colour comes from, when it is inherited or shows through. */
  readonly source: string | null;
  /** `hover` for a colour the element shows only while hovered, pressed or focused. */
  readonly state: 'rest' | 'hover';
}

interface Candidate {
  readonly category: PickCategory;
  readonly property: string;
  readonly value: string;
  readonly tokens: readonly string[];
}

const CATEGORY_ORDER: readonly Exclude<PickCategory, 'canvas'>[] = ['background', 'text', 'border', 'outline', 'shadow', 'fill', 'stroke'];
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Colour shorthands. A shorthand written with `var()` is pending substitution,
 * so its longhands read back empty and only the shorthand holds the text.
 */
const SHORTHANDS = [
  'background', 'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-block', 'border-inline', 'border-block-start', 'border-block-end', 'border-inline-start', 'border-inline-end',
  'border-block-color', 'border-inline-color', 'outline'
];

/** The renderer tokens that paint the chart's surroundings, which are the only canvas pixels a pick names. */
const CANVAS_TOKENS = ['--renderer-off-canvas-color', '--renderer-ghost-grid-color', '--renderer-ghost-major-grid-color'];

const isToken = (name: string) => name.startsWith('--color-') || name.startsWith('--renderer-');

/** The custom property names a value reads through `var()`, in order. */
export function varNames(value: string): string[] {
  const names: string[] = [];
  let index = value.indexOf('var(');
  while (index !== -1) {
    let start = index + 4;
    while (value[start] === ' ') start += 1;
    let end = start;
    while (end < value.length && value[end] !== ',' && value[end] !== ')' && value[end] !== ' ') end += 1;
    const name = value.slice(start, end);
    if (name.startsWith('--')) names.push(name);
    index = value.indexOf('var(', end);
  }
  return names;
}

function categoryOf(property: string): PickCategory | null {
  if (property.startsWith('background')) return 'background';
  if (property === 'color') return 'text';
  if (property.startsWith('border')) return 'border';
  if (property.startsWith('outline')) return 'outline';
  if (property === 'box-shadow' || property === 'text-shadow') return 'shadow';
  if (property === 'fill' || property === 'stroke') return property;
  return null;
}

/** The computed longhands a declaration of `property` is compared on. */
function comparedLonghands(property: string): string[] {
  if (property === 'background') return ['background-color', 'background-image'];
  if (property.startsWith('border')) {
    if (property.endsWith('-width') || property.endsWith('-style') || property.endsWith('-radius')) return [];
    const side = SIDES.find((candidate) => property.includes(candidate));
    return side ? [`border-${side}-color`] : SIDES.map((candidate) => `border-${candidate}-color`);
  }
  if (property.startsWith('outline')) return ['outline-color'];
  return [property];
}

/** Every declaration in `style` whose value names a colour token, longhands and colour shorthands both. */
function declarationsOf(style: CSSStyleDeclaration): Candidate[] {
  const properties = [...Array.from({ length: style.length }, (_, index) => style[index]), ...SHORTHANDS];
  const found: Candidate[] = [];
  for (const property of new Set(properties)) {
    const category = categoryOf(property);
    if (!category) continue;
    const value = style.getPropertyValue(property);
    const tokens = varNames(value).filter(isToken);
    if (tokens.length > 0) found.push({ category, property, value, tokens });
  }
  return found;
}

/** Every style rule that could apply, in document order, through the `@media` and `@supports` blocks that currently hold. */
function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) yield rule;
    else if (rule instanceof CSSMediaRule) {
      if (matchMedia(rule.conditionText).matches) yield* styleRules(rule.cssRules);
    } else if (rule instanceof CSSSupportsRule) {
      if (CSS.supports(rule.conditionText)) yield* styleRules(rule.cssRules);
    }
  }
}

/** Every style rule of every readable stylesheet, in document order. */
function* documentRules(): Generator<CSSStyleRule> {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // A cross-origin sheet cannot be read.
    }
    yield* styleRules(rules);
  }
}

function candidatesFor(element: Element): Candidate[] {
  const found: Candidate[] = [];
  for (const rule of documentRules()) {
    let matches = false;
    try {
      matches = element.matches(rule.selectorText);
    } catch {
      // Selectors `matches` rejects, such as pseudo-elements, never match the element itself.
    }
    if (matches) found.push(...declarationsOf(rule.style));
  }
  if (element instanceof HTMLElement || element instanceof SVGElement) found.push(...declarationsOf(element.style));
  return found;
}

const STATE_PSEUDO_CLASSES = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within']);

const isIdentifierChar = (char: string) => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '-' || char === '_';

/**
 * `selector` with each pseudo-class or pseudo-element, such as `:hover` or
 * `::before`, replaced by what `map` returns for it. Each name is read whole,
 * so `:focus` is never mistaken for `:focus-visible`; escaped characters and
 * quoted attribute values are copied as they are. Arguments are not part of
 * the name, so the pseudo-classes inside `:not(...)` are mapped too.
 */
function mapPseudos(selector: string, map: (pseudo: string) => string): string {
  let out = '';
  let index = 0;
  while (index < selector.length) {
    const char = selector[index];
    if (char === '\\') {
      // An escaped character, such as the colon in `.md\:flex`, is part of a name.
      out += selector.slice(index, index + 2);
      index += 2;
    } else if (char === '"' || char === "'") {
      const close = selector.indexOf(char, index + 1);
      const end = close === -1 ? selector.length : close + 1;
      out += selector.slice(index, end);
      index = end;
    } else if (char === ':') {
      let end = selector[index + 1] === ':' ? index + 2 : index + 1;
      while (end < selector.length && isIdentifierChar(selector[end])) end += 1;
      out += map(selector.slice(index, end));
      index = end;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

const isState = (pseudo: string) => !pseudo.startsWith('::') && STATE_PSEUDO_CLASSES.has(pseudo.slice(1).toLowerCase());

/** `selector` with every state pseudo-class replaced by `replacement`: `:not(*)` for "never in that state", `:is(*)` for "always". */
export function replaceStates(selector: string, replacement: string): string {
  return mapPseudos(selector, (pseudo) => (isState(pseudo) ? replacement : pseudo));
}

/**
 * Runs `lookup` as if nothing were hovered, pressed or focused, by rewriting the
 * state pseudo-classes out of every rule and restoring them afterwards. It all
 * happens in one task, so nothing paints and no hot update lands in between. A
 * rule whose rewritten selector the browser refuses keeps its own.
 */
function atRest<T>(lookup: () => T): T {
  const rewritten: [CSSStyleRule, string][] = [];
  try {
    for (const rule of documentRules()) {
      const original = rule.selectorText;
      const neutral = replaceStates(original, ':not(*)');
      if (neutral === original) continue;
      try {
        rule.selectorText = neutral;
      } catch {
        continue;
      }
      if (rule.selectorText !== original) rewritten.push([rule, original]);
    }
    return lookup();
  } finally {
    for (const [rule, original] of rewritten) rule.selectorText = original;
  }
}

/**
 * The rest entries, then each state entry whose token its category does not
 * already show at rest: a hover colour, or a category only the hover state paints.
 */
function mergeStates(rest: readonly PickedToken[], state: readonly PickedToken[]): PickedToken[] {
  const shown = (entry: PickedToken) => rest.some((candidate) => candidate.category === entry.category && candidate.chain[0] === entry.chain[0]);
  return [...rest, ...state.filter((entry) => !shown(entry))];
}

/** The last candidate of `category` whose declaration computes to what `element` computes. */
function winner(candidates: readonly Candidate[], category: PickCategory, element: Element): Candidate | null {
  const computed = getComputedStyle(element);
  let found: Candidate | null = null;
  for (const candidate of candidates) {
    if (candidate.category !== category) continue;
    const longhands = comparedLonghands(candidate.property);
    if (longhands.length === 0) continue;
    const probed = probeComputed(candidate.property, candidate.value, longhands);
    if (longhands.every((longhand, index) => probed[index] === computed.getPropertyValue(longhand))) found = candidate;
  }
  return found;
}

const isTransparent = (element: Element) => {
  const computed = getComputedStyle(element);
  return computed.backgroundImage === 'none' && computed.backgroundColor === 'rgba(0, 0, 0, 0)';
};

/** `tag#id` or `tag.first-class`, enough to name an ancestor in the readout. */
export function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (element.id) return `${tag}#${element.id}`;
  const className = element.classList[0];
  return className ? `${tag}.${className}` : tag;
}

/** The element a pick at (x, y) names when no canvas chrome is under it: the topmost one that is neither a canvas nor part of the editor. */
export function pickTarget(x: number, y: number, editor: Element | null): Element | null {
  return document.elementsFromPoint(x, y).find((element) => !(element instanceof HTMLCanvasElement) && !editor?.contains(element)) ?? null;
}

/** The pixel of `canvas` under the client point, as `#RRGGBB`; '' where it is transparent, null when it cannot be read. */
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): string | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const column = Math.floor((x - rect.left) * canvas.width / rect.width);
  const row = Math.floor((y - rect.top) * canvas.height / rect.height);
  try {
    const context = canvas.getContext('2d');
    if (!context) return null;
    const [red, green, blue, alpha] = context.getImageData(column, row, 1, 1).data;
    if (alpha === 0) return '';
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  } catch {
    // A canvas with another context, or a tainted one, cannot be read back.
    return null;
  }
}

/**
 * The canvases under (x, y), topmost first. The chart's canvases are
 * `pointer-events: none`, so elementsFromPoint never lists them; when nothing
 * covers them the topmost hit is their container. Only that topmost hit counts:
 * a button over the chart is what was clicked, not the canvas beneath it. A hit
 * canvas is itself the answer, otherwise its descendant canvases whose box holds
 * the point, latest in document order first because a later sibling paints over
 * an earlier one (the overlay over the base).
 */
function canvasesAt(x: number, y: number, editor: Element | null): HTMLCanvasElement[] {
  const top = document.elementsFromPoint(x, y).find((element) => !editor?.contains(element));
  if (!top) return [];
  if (top instanceof HTMLCanvasElement) return [top];
  return Array.from(top.querySelectorAll('canvas')).filter((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom && !editor?.contains(canvas);
  }).reverse();
}

/**
 * The canvas chrome under (x, y): the topmost canvas whose pixel there is not
 * transparent decides, and it names a token only when that pixel is exactly
 * the colour a canvas chrome token resolves to.
 */
export function canvasAt(x: number, y: number, editor: Element | null): { readonly canvas: HTMLCanvasElement; readonly token: string } | null {
  for (const canvas of canvasesAt(x, y, editor)) {
    const pixel = pixelAt(canvas, x, y);
    if (pixel === '') continue;
    const token = pixel ? CANVAS_TOKENS.find((name) => resolveColor(`var(${name})`) === pixel) : undefined;
    return token ? { canvas, token } : null;
  }
  return null;
}

/** Follows a token the selected theme does not declare through Needlewise while its value there is exactly one `var()`. */
function follow(token: string, declared: ReadonlySet<string>, defaults: ReadonlyMap<string, string>): { chain: string[]; target: string | null } {
  const chain = [token];
  let last = token;
  while (!declared.has(last)) {
    const value = defaults.get(last)?.trim();
    const [next] = value ? varNames(value) : [];
    if (!next || value !== `var(${next})` || chain.includes(next)) break;
    chain.push(next);
    last = next;
  }
  return { chain, target: declared.has(last) ? last : null };
}

/** What a pick at (x, y) found: the canvas chrome token under it, else the tokens of the element beneath. */
export function pickAt(x: number, y: number, editor: Element | null, declared: ReadonlySet<string>, defaults: ReadonlyMap<string, string>): { element: Element; entries: PickedToken[] } | null {
  const chrome = canvasAt(x, y, editor);
  if (chrome) return { element: chrome.canvas, entries: [{ category: 'canvas', property: 'pixel', ...follow(chrome.token, declared, defaults), source: null, state: 'rest' }] };
  const element = pickTarget(x, y, editor);
  if (!element) return null;
  const rest = atRest(() => tokensAt(element, declared, defaults, 'rest'));
  return { element, entries: mergeStates(rest, tokensAt(element, declared, defaults, 'hover')) };
}

/**
 * The tokens `element` paints with, one entry per token of each category's
 * winning declaration. `declared` holds the selected theme's tokens and
 * `defaults` Needlewise's values.
 */
function tokensAt(element: Element, declared: ReadonlySet<string>, defaults: ReadonlyMap<string, string>, state: PickedToken['state']): PickedToken[] {
  const own = candidatesFor(element);
  const picked: PickedToken[] = [];
  const add = (found: Candidate, source: Element | null) => {
    for (const token of found.tokens) {
      picked.push({ category: found.category, property: found.property, ...follow(token, declared, defaults), source: source ? describeElement(source) : null, state });
    }
  };

  for (const category of CATEGORY_ORDER) {
    const found = winner(own, category, element);
    if (found) {
      add(found, null);
      continue;
    }
    if (category === 'text') {
      // `color` inherits: the nearest ancestor whose own rule computes to this element's colour set it.
      const target = getComputedStyle(element).color;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).color !== target) break;
        const inherited = winner(candidatesFor(ancestor), 'text', ancestor);
        if (inherited) {
          add(inherited, ancestor);
          break;
        }
      }
    } else if (category === 'background' && isTransparent(element)) {
      // A transparent element shows the first ancestor that paints a background.
      let ancestor = element.parentElement;
      while (ancestor && isTransparent(ancestor)) ancestor = ancestor.parentElement;
      const shown = ancestor ? winner(candidatesFor(ancestor), 'background', ancestor) : null;
      if (ancestor && shown) add(shown, ancestor);
    }
  }
  return picked;
}

/** Pseudo-elements written with the legacy single colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set([':before', ':after', ':first-line', ':first-letter']);

/**
 * Whether any element outside the editor matches `selector` in some state. The
 * query drops pseudo-elements, which `querySelector` cannot match, and is tried
 * with every state pseudo-class true and again with every one false, so both
 * `:hover` and `:not(:hover)` rules count while their element exists.
 */
function matchesOnPage(selector: string, editor: Element | null): boolean {
  const unpseudo = mapPseudos(selector, (pseudo) => (pseudo.startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(pseudo.toLowerCase()) ? '' : pseudo));
  return [':is(*)', ':not(*)'].some((replacement) => {
    try {
      const query = replaceStates(unpseudo, replacement);
      const first = document.querySelector(query);
      if (!first) return false;
      if (!editor?.contains(first)) return true;
      return Array.from(document.querySelectorAll(query)).some((element) => !editor.contains(element));
    } catch {
      return false; // A selector left empty, such as a lone `::selection`, matches nothing.
    }
  });
}

/**
 * The tokens the page outside the editor can paint with right now: those named
 * by every colour declaration whose rule matches some element, by inline
 * styles, and every renderer token while the chart canvas is on the page, then
 * every token those reference through the theme's `values`, or Needlewise's
 * `defaults` where the theme does not declare one.
 *
 * A rule counts when it matches anything, even if a more specific rule always
 * overrides it, so the set can hold a few extra tokens but never misses one the
 * page uses.
 */
export function tokensOnPage(editor: Element | null, values: ReadonlyMap<string, string>, defaults: ReadonlyMap<string, string>): Set<string> {
  const used = new Set<string>();
  for (const rule of documentRules()) {
    const tokens = declarationsOf(rule.style).flatMap((candidate) => candidate.tokens);
    if (tokens.length > 0 && matchesOnPage(rule.selectorText, editor)) for (const token of tokens) used.add(token);
  }
  for (const element of Array.from(document.querySelectorAll('[style*="var(--"]'))) {
    if (editor?.contains(element) || !(element instanceof HTMLElement || element instanceof SVGElement)) continue;
    for (const candidate of declarationsOf(element.style)) for (const token of candidate.tokens) used.add(token);
  }
  if (document.querySelector('.canvas-frame canvas')) {
    for (const name of [...values.keys(), ...defaults.keys()]) if (name.startsWith('--renderer-')) used.add(name);
  }
  // A Set iterates the entries added while it is being iterated, so this runs to a fixed point.
  for (const token of used) {
    const value = values.get(token) ?? defaults.get(token);
    if (value) for (const name of varNames(value)) used.add(name);
  }
  return used;
}

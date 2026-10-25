import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG_DEFINITION } from '../catalog';
import { createDocument } from '../domain';
import { DEFAULT_RENDERER_STYLE, type RendererStyle } from '../editor/contracts';
import { getCanvasMetrics } from '../editor/coordinates';
import { createCanvasRenderer } from './renderer';
import { RENDERER_COLOR_FIELDS, readRendererColors, readThemeColor, rendererColorToken, subscribeThemeChange } from './theme-colors';

/** Stubs the root's computed style with `tokens`; every other property reads as unset. */
function stubTokens(tokens: Record<string, string>) {
  return vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    getPropertyValue: (name: string) => tokens[name] ?? ''
  }) as CSSStyleDeclaration);
}

function renderer(style?: Partial<RendererStyle>) {
  return createCanvasRenderer({
    document: createDocument({ catalog: DEFAULT_CATALOG_DEFINITION.association, width: 1, height: 1 }),
    targets: {} as never,
    metrics: getCanvasMetrics(16, 16),
    ...(style ? { style } : {})
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme colors', () => {
  it('names each renderer colour token after its field', () => {
    expect(rendererColorToken('selectionColor')).toBe('--renderer-selection-color');
    expect(rendererColorToken('lightStitchMajorGridColor')).toBe('--renderer-light-stitch-major-grid-color');
  });

  it('covers every string colour field of the default style', () => {
    const colorFields = Object.keys(DEFAULT_RENDERER_STYLE).filter((key) => key.endsWith('Color') && typeof DEFAULT_RENDERER_STYLE[key as keyof typeof DEFAULT_RENDERER_STYLE] === 'string');
    expect([...RENDERER_COLOR_FIELDS].sort()).toEqual(colorFields.sort());
  });

  it('falls back to the defaults without a stylesheet', () => {
    const colors = readRendererColors();
    for (const field of RENDERER_COLOR_FIELDS) expect(colors[field]).toBe(DEFAULT_RENDERER_STYLE[field]);
    expect(readThemeColor('--color-surface', '#fffdf9')).toBe('#fffdf9');
  });

  it('reads set tokens, trimmed, and falls back per field for the rest', () => {
    stubTokens({ '--renderer-selection-color': ' #00ff00', '--color-ink': '#111111 ' });
    const colors = readRendererColors();
    expect(colors.selectionColor).toBe('#00ff00');
    expect(colors.gridColor).toBe(DEFAULT_RENDERER_STYLE.gridColor);
    expect(readThemeColor('--color-ink', '#272321')).toBe('#111111');
  });

  it('notifies on a data-theme change until unsubscribed', async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeThemeChange(onChange);
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    document.documentElement.setAttribute('data-theme', 'light');
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('notifies when the system colour scheme changes', () => {
    const listeners: (() => void)[] = [];
    const query = { addEventListener: (_: string, listener: () => void) => listeners.push(listener), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => query));
    const onChange = vi.fn();
    const unsubscribe = subscribeThemeChange(onChange);
    listeners.forEach((listener) => listener());
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(query.removeEventListener).toHaveBeenCalledWith('change', onChange);
    vi.unstubAllGlobals();
  });
});

describe('renderer theme colours', () => {
  it('takes the theme colours at creation, under caller settings', () => {
    stubTokens({ '--renderer-grid-color': '#010101', '--renderer-cursor-color': '#020202' });
    const subject = renderer({ cursorColor: '#030303' });
    expect(subject.getStyle().gridColor).toBe('#010101');
    expect(subject.getStyle().cursorColor).toBe('#030303');
    expect(subject.getStyle().selectionColor).toBe(DEFAULT_RENDERER_STYLE.selectionColor);
    subject.dispose();
  });

  it('re-reads the theme colours on a theme change and keeps its settings', async () => {
    const subject = renderer();
    subject.setStyle({ showGrid: false });
    stubTokens({ '--renderer-grid-color': '#0a0a0a' });
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    expect(subject.getStyle().gridColor).toBe('#0a0a0a');
    expect(subject.getStyle().showGrid).toBe(false);
    subject.dispose();
  });

  it('stops following the theme once disposed', async () => {
    const subject = renderer();
    subject.dispose();
    stubTokens({ '--renderer-grid-color': '#0b0b0b' });
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    expect(subject.getStyle().gridColor).toBe(DEFAULT_RENDERER_STYLE.gridColor);
  });
});

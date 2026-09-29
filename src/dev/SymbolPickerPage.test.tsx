import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SymbolPickerPage from './SymbolPickerPage';
import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';

/**
 * The picker draws two vendored fonts over one codepoint space, so the pool is
 * addressed by "<font-slug>:U+XXXX" and never by the codepoint alone. The list
 * is grouped by codepoint, and which fonts it holds is a multi-select rather
 * than a filter, so a row is only there when a compared font can draw it.
 *
 * Every expectation below is derived from the generated candidates and the
 * committed selection, so curating the pool never has to edit these numbers.
 */
const candidates = candidatesAsset.candidates;
const fontFamilies = candidatesAsset.fonts;
const fontSlugs = Object.keys(fontFamilies);
const selection = selectionAsset.selection;

/** The codepoint both fonts hold and the pool names, which the page groups side by side. */
const SHARED = 0x2666;

const formatCodepoint = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const familyOf = (slug: string): string => fontFamilies[slug as keyof typeof fontFamilies].family;

const glyphsByCodepoint = new Map<number, string[]>();
for (const candidate of candidates) {
  glyphsByCodepoint.set(candidate.codepoint, [...(glyphsByCodepoint.get(candidate.codepoint) ?? []), candidate.font]);
}

const allCodepoints = [...glyphsByCodepoint.keys()].sort((a, b) => a - b);
const codepointsFor = (slug: string): number => allCodepoints.filter((codepoint) => glyphsByCodepoint.get(codepoint)!.includes(slug)).length;

/** The lowest codepoint only one font can draw, so the list must follow that font's tick. */
const exclusiveTo = (slug: string): number => allCodepoints
  .find((codepoint) => {
    const fonts = glyphsByCodepoint.get(codepoint)!;
    return fonts.length === 1 && fonts[0] === slug;
  })!;

const selectedFor = (slug: string): number => selection.filter((entry) => entry.startsWith(`${slug}:`)).length;

const ticked = [...new Set(selection.map((entry) => Number.parseInt(entry.split(':')[1].slice(2), 16)))];

/** The ticked codepoints the list holds with one font compared, or with all of them. */
const tickedCodepoints = (slug?: string): number => ticked
  .filter((codepoint) => !slug || glyphsByCodepoint.get(codepoint)!.includes(slug)).length;

/** The codepoints a search would leave in the list, by the same rule the page filters on. */
const matching = (needle: string): number => {
  const lowered = needle.toLowerCase();
  const asCodepoint = lowered.startsWith('u+') ? Number.parseInt(lowered.slice(2), 16) : null;
  return allCodepoints.filter((codepoint) => glyphsByCodepoint.get(codepoint)!.some((slug) => {
    const candidate = candidates.find((one) => one.codepoint === codepoint && one.font === slug)!;
    return candidate.name.includes(lowered)
      || candidate.block.toLowerCase().includes(lowered)
      || candidate.id.includes(lowered)
      || familyOf(slug).toLowerCase().includes(lowered)
      || (asCodepoint !== null && candidate.codepoint === asCodepoint)
      || String.fromCodePoint(candidate.codepoint) === lowered;
  })).length;
};

/** The picker paints one page of codepoints and grows the page as the list scrolls. */
const PAGE = 200;

const shownLine = (shown: number, total: number): string => `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}.`;

const listOf = (container: HTMLElement): HTMLElement => within(container).getByRole('region', { name: 'Codepoints' });
const countOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.symbol-picker-count')!;
const searchBox = (): HTMLInputElement => screen.getByLabelText('Search');
const fontChip = (slug: string): HTMLInputElement => screen.getByRole('checkbox', { name: new RegExp(familyOf(slug)) });
const reviewToggle = (): HTMLInputElement => screen.getByRole('checkbox', { name: /Selected only/ });

const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.symbol-picker-item')];
const variants = (row: HTMLElement): HTMLElement[] => [...row.querySelectorAll<HTMLElement>('.symbol-picker-variant')];
const rowFor = (container: HTMLElement, codepoint: number): HTMLElement | null =>
  rows(container).find((row) => row.querySelector('.symbol-picker-codepoint')?.textContent === formatCodepoint(codepoint)) ?? null;

/** The variant a codepoint holds for one font, found by the family name printed under its glyph. */
const variantFor = (row: HTMLElement, slug: string): HTMLElement =>
  within(row).getByText(familyOf(slug)).closest<HTMLElement>('button')!;

/** Type a query and wait for the deferred, filtered list to settle. */
const showOnly = async (container: HTMLElement, query: string): Promise<void> => {
  fireEvent.change(searchBox(), { target: { value: query } });
  await waitFor(() => expect(countOf(container)).toHaveTextContent(/matching/), { timeout: 5000 });
};

const growThePage = (container: HTMLElement): void => {
  fireEvent.scroll(listOf(container));
  expect(listOf(container)).toHaveTextContent(shownLine(PAGE * 2, allCodepoints.length));
};

/**
 * The size strip has to be tall enough for its largest sample, and jsdom does no
 * layout, so the box is checked where the layout would be decided: the computed
 * height must be content-driven and the ink must not be clipped away. The
 * display and alignment come from the same rule as the height, so they prove
 * the rule was resolved and the other two are read from it and not defaulted.
 */
const expectNoClipping = (box: HTMLElement, largestSample: number): void => {
  const computed = getComputedStyle(box);
  expect(computed.display).toBe('flex');
  expect(computed.alignItems).toBe('flex-end');
  expect(computed.height).toBe('auto');
  expect(computed.overflow).not.toBe('hidden');
  expect(largestSample).toBeGreaterThan(0);
};

describe('SymbolPickerPage', () => {
  it('lists codepoints in ascending order, one row per codepoint, each titled with it', () => {
    const view = render(<SymbolPickerPage />);
    const listed = rows(view.container);
    expect(listed).toHaveLength(PAGE);
    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, allCodepoints.length));

    const codepoints = listed.map((row) => Number.parseInt(
      row.querySelector('.symbol-picker-codepoint')!.textContent!.slice(2),
      16
    ));
    expect(codepoints).toEqual([...codepoints].sort((a, b) => a - b));
    expect(new Set(codepoints).size).toBe(codepoints.length);

    for (const row of listed) {
      const heading = within(row).getByRole('heading');
      const codepoint = Number.parseInt(heading.textContent!.slice(2, 6), 16);
      const name = candidates.find((candidate) => candidate.codepoint === codepoint)!.name;
      expect(heading).toHaveTextContent(formatCodepoint(codepoint));
      expect(heading).toHaveTextContent(name);
      // A row holds one variant per compared font that can draw the codepoint.
      expect(variants(row)).toHaveLength(glyphsByCodepoint.get(codepoint)!.length);
    }
  }, 15000);

  it('shows a codepoint one font can draw as a row of one, with no empty placeholder', async () => {
    const view = render(<SymbolPickerPage />);
    const only = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(only));

    const row = rowFor(view.container, only)!;
    expect(variants(row)).toHaveLength(1);
    expect(variantFor(row, 'libertinus-math')).toBeInTheDocument();
    expect(within(row).queryByText(familyOf('noto-sans-symbols-2'))).toBeNull();
  }, 15000);

  it('groups a shared codepoint into one row of one variant per font', async () => {
    const view = render(<SymbolPickerPage />);
    expect(glyphsByCodepoint.get(SHARED)).toEqual(fontSlugs);
    await showOnly(view.container, formatCodepoint(SHARED));

    const row = rowFor(view.container, SHARED)!;
    expect(rows(view.container)).toHaveLength(1);
    expect(variants(row)).toHaveLength(fontSlugs.length);
    for (const slug of fontSlugs) {
      expect(variantFor(row, slug)).toBeInTheDocument();
    }
  }, 15000);

  it('toggles one font\'s copy of a shared codepoint without disturbing the other font', async () => {
    expect(selection).toEqual(expect.arrayContaining(fontSlugs.map((slug) => `${slug}:U+2666`)));
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));

    const row = rowFor(view.container, SHARED)!;
    const libertinus = variantFor(row, 'libertinus-math');
    const noto = variantFor(row, 'noto-sans-symbols-2');
    expect(libertinus).toHaveAttribute('aria-pressed', 'true');
    expect(noto).toHaveAttribute('aria-pressed', 'true');
    expect(countOf(view.container)).toHaveTextContent(`${selection.length} selected`);

    fireEvent.click(libertinus);

    expect(libertinus).toHaveAttribute('aria-pressed', 'false');
    expect(noto).toHaveAttribute('aria-pressed', 'true');
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
    expect(countOf(view.container)).toHaveTextContent(`${familyOf('libertinus-math')} ${selectedFor('libertinus-math') - 1}`);
    expect(countOf(view.container)).toHaveTextContent(`${familyOf('noto-sans-symbols-2')} ${selectedFor('noto-sans-symbols-2')}`);
  }, 15000);

  it('compares any number of fonts at once, and the list follows the tick', async () => {
    const view = render(<SymbolPickerPage />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toEqual([]);
    for (const slug of fontSlugs) expect(fontChip(slug)).toBeChecked();

    const only = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(only));
    expect(variants(rowFor(view.container, only)!)).toHaveLength(1);

    fireEvent.click(fontChip('libertinus-math'));

    expect(fontChip('libertinus-math')).not.toBeChecked();
    expect(fontChip('noto-sans-symbols-2')).toBeChecked();
    expect(rowFor(view.container, only)).toBeNull();
    expect(listOf(view.container)).toHaveTextContent('No codepoints match this search.');

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(rows(view.container)).toEqual([]);
    expect(listOf(view.container)).toHaveTextContent('No fonts are being compared.');
  }, 15000);

  it('renders each variant as its glyph, then the font it belongs to, then size previews', async () => {
    const view = render(<SymbolPickerPage />);
    const faces = view.container.querySelector('style')!.textContent ?? '';
    for (const slug of fontSlugs) {
      expect(faces).toMatch(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${slug}"[^}]*url\\("/__symbols/font/${slug}\\.ttf"\\)`));
    }
    expect(faces.match(/@font-face/g)).toHaveLength(fontSlugs.length);

    await showOnly(view.container, formatCodepoint(SHARED));
    const row = rowFor(view.container, SHARED)!;
    for (const slug of fontSlugs) {
      const variant = variantFor(row, slug);
      const face = `"${slug}", serif`;
      expect([...variant.children].map((child) => child.className)).toEqual([
        'symbol-picker-glyph',
        'symbol-picker-font-name',
        'symbol-picker-sizes'
      ]);
      const glyph = variant.querySelector<HTMLElement>('.symbol-picker-glyph')!;
      expect(glyph).toHaveTextContent(String.fromCodePoint(SHARED));
      expect(glyph).toHaveStyle({ fontFamily: face });
      expect(variant.querySelector('.symbol-picker-font-name')).toHaveTextContent(familyOf(slug));
      const samples = [...variant.querySelectorAll<HTMLElement>('.symbol-picker-sizes b')];
      expect(samples.map((sample) => sample.style.fontFamily)).toEqual([face, face, face]);
      expect(samples.map((sample) => sample.style.fontSize)).toEqual(['8px', '16px', '24px']);
    }
  }, 15000);

  it('sizes the glyph and its size strip from the samples, so the largest one is not clipped', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const variant = variantFor(rowFor(view.container, SHARED)!, 'libertinus-math');

    const sizes = variant.querySelector<HTMLElement>('.symbol-picker-sizes')!;
    const largest = Math.max(
      ...[...variant.querySelectorAll<HTMLElement>('.symbol-picker-sizes b')].map((sample) => Number.parseFloat(sample.style.fontSize))
    );
    expectNoClipping(sizes, largest);
    // The samples are laid out at the sizes a chart uses, so the box is taller
    // than the old fixed strip once it is sized from them.
    expect(largest).toBe(24);

    const glyph = variant.querySelector<HTMLElement>('.symbol-picker-glyph')!;
    const glyphStyle = getComputedStyle(glyph);
    expect(glyphStyle.display).toBe('flex');
    expect(glyphStyle.height).toBe('auto');
    expect(glyphStyle.width).toBe('auto');
    expect(Number.parseFloat(glyphStyle.minHeight)).toBeGreaterThanOrEqual(largest);
  }, 15000);

  it('reviews the ticked symbols and drops the search on entry', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    fireEvent.click(reviewToggle());

    expect(searchBox()).toHaveValue('');
    expect(reviewToggle()).toBeChecked();
    expect(rows(view.container)).toHaveLength(tickedCodepoints());
    expect(listOf(view.container)).not.toHaveTextContent(/Showing /);

    fireEvent.click(variantFor(rowFor(view.container, SHARED)!, 'libertinus-math'));

    const row = rowFor(view.container, SHARED)!;
    expect(variants(row)).toHaveLength(1);
    expect(variantFor(row, 'noto-sans-symbols-2')).toBeInTheDocument();
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
  }, 15000);

  it('spans the compared fonts alone while reviewing, since the pool is font-specific', async () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    expect(rows(view.container)).toHaveLength(tickedCodepoints());

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(fontChip('noto-sans-symbols-2')).not.toBeChecked();
    expect(rows(view.container)).toHaveLength(tickedCodepoints('libertinus-math'));
    expect(view.container.querySelectorAll('.symbol-picker-font-name')).toHaveLength(tickedCodepoints('libertinus-math'));
    for (const name of view.container.querySelectorAll('.symbol-picker-font-name')) {
      expect(name).toHaveTextContent(familyOf('libertinus-math'));
    }
  }, 15000);

  it('applies Select shown and Clear shown to every font at the listed codepoints', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const fontsAtPlay = glyphsByCodepoint.get(SHARED)!.length;

    fireEvent.click(screen.getByRole('button', { name: 'Clear shown' }));
    for (const slug of fontSlugs) {
      expect(variantFor(rowFor(view.container, SHARED)!, slug)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - fontsAtPlay} selected`);

    fireEvent.click(screen.getByRole('button', { name: 'Select shown' }));
    for (const slug of fontSlugs) {
      expect(variantFor(rowFor(view.container, SHARED)!, slug)).toHaveAttribute('aria-pressed', 'true');
    }
    expect(countOf(view.container)).toHaveTextContent(`${selection.length} selected`);
  }, 15000);

  it('returns the list to the top of a fresh page when the search box changes', async () => {
    const view = render(<SymbolPickerPage />);
    growThePage(view.container);
    listOf(view.container).scrollTop = 512;

    const narrowed = 'miscellaneous symbols';
    // More matches than one page, so a stale page size would paint them all.
    expect(matching(narrowed)).toBeGreaterThan(PAGE);
    await showOnly(view.container, narrowed);

    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, matching(narrowed)));
    expect(listOf(view.container).scrollTop).toBe(0);
  }, 15000);

  it('returns the list to the top of a fresh page when the compared fonts change', () => {
    const view = render(<SymbolPickerPage />);
    growThePage(view.container);
    listOf(view.container).scrollTop = 512;

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, codepointsFor('libertinus-math')));
    expect(listOf(view.container).scrollTop).toBe(0);
  }, 15000);
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SymbolPickerPage from './SymbolPickerPage';
import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';

/**
 * The picker draws two vendored fonts over one codepoint space, so the pool is
 * addressed by "<font-slug>:U+XXXX" and never by the codepoint alone. The grid
 * is grouped by codepoint, and which fonts it holds is a multi-select rather
 * than a filter, so a card is only there when a compared font can draw it.
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

/** The lowest codepoint only one font can draw, so the grid must follow that font's tick. */
const exclusiveTo = (slug: string): number => allCodepoints
  .find((codepoint) => {
    const fonts = glyphsByCodepoint.get(codepoint)!;
    return fonts.length === 1 && fonts[0] === slug;
  })!;

const selectedFor = (slug: string): number => selection.filter((entry) => entry.startsWith(`${slug}:`)).length;

const ticked = [...new Set(selection.map((entry) => Number.parseInt(entry.split(':')[1].slice(2), 16)))];

/** The ticked codepoints the grid holds with one font compared, or with all of them. */
const tickedCodepoints = (slug?: string): number => ticked
  .filter((codepoint) => !slug || glyphsByCodepoint.get(codepoint)!.includes(slug)).length;

/** The codepoints a search would leave in the grid, by the same rule the page filters on. */
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

/** The picker paints one page of codepoints and grows the page as the grid scrolls. */
const PAGE = 200;

const shownLine = (shown: number, total: number): string => `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}.`;

const listOf = (container: HTMLElement): HTMLElement => within(container).getByRole('region', { name: 'Codepoints' });
const countOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.symbol-picker-count')!;
const searchBox = (): HTMLInputElement => screen.getByLabelText('Search');
const fontChip = (slug: string): HTMLInputElement => screen.getByRole('checkbox', { name: new RegExp(familyOf(slug)) });
const reviewToggle = (): HTMLInputElement => screen.getByRole('checkbox', { name: /Selected only/ });

const cards = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.symbol-picker-card')];
const variants = (card: HTMLElement): HTMLElement[] => [...card.querySelectorAll<HTMLElement>('.symbol-picker-variant')];
const cardFor = (container: HTMLElement, codepoint: number): HTMLElement | null =>
  cards(container).find((card) => card.querySelector('.symbol-picker-codepoint')?.textContent === formatCodepoint(codepoint)) ?? null;

/** The variant a codepoint holds for one font, found by the family name printed under its glyph. */
const variantFor = (card: HTMLElement, slug: string): HTMLElement =>
  within(card).getByText(familyOf(slug)).closest<HTMLElement>('button')!;

/** Type a query and wait for the deferred, filtered grid to settle. */
const showOnly = async (container: HTMLElement, query: string): Promise<void> => {
  fireEvent.change(searchBox(), { target: { value: query } });
  await waitFor(() => expect(countOf(container)).toHaveTextContent(/matching/), { timeout: 5000 });
};

const growThePage = (container: HTMLElement): void => {
  fireEvent.scroll(listOf(container));
  expect(listOf(container)).toHaveTextContent(shownLine(PAGE * 2, allCodepoints.length));
};

/**
 * A rule from the page's own stylesheet, which is where the layout is decided.
 * jsdom does no layout, so a declaration is read from the rule rather than from
 * a measured box.
 */
const ruleFor = (selector: string): CSSStyleRule => {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) return rule;
    }
  }
  throw new Error(`No rule for ${selector} in the picker's stylesheet.`);
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
  it('lists codepoints in ascending order, one card per codepoint, each titled with it', () => {
    const view = render(<SymbolPickerPage />);
    const listed = cards(view.container);
    expect(listed).toHaveLength(PAGE);
    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, allCodepoints.length));

    const codepoints = listed.map((card) => Number.parseInt(
      card.querySelector('.symbol-picker-codepoint')!.textContent!.slice(2),
      16
    ));
    expect(codepoints).toEqual([...codepoints].sort((a, b) => a - b));
    expect(new Set(codepoints).size).toBe(codepoints.length);

    for (const card of listed) {
      const heading = within(card).getByRole('heading');
      const codepoint = Number.parseInt(heading.textContent!.slice(2, 6), 16);
      const name = candidates.find((candidate) => candidate.codepoint === codepoint)!.name;
      expect(heading).toHaveTextContent(formatCodepoint(codepoint));
      expect(heading).toHaveTextContent(name);
      // A card holds one variant per compared font that can draw the codepoint.
      expect(variants(card)).toHaveLength(glyphsByCodepoint.get(codepoint)!.length);
    }
  }, 15000);

  it('turns the layout on the number of compared fonts rather than a fixed column count', () => {
    const view = render(<SymbolPickerPage />);
    const grid = listOf(view.container);
    expect(grid.style.getPropertyValue('--compared-fonts')).toBe(String(fontSlugs.length));

    // The count is what sets the width of one font's column, so a stylesheet
    // that hardcoded the column would leave nothing here to turn on.
    const track = ruleFor('.symbol-picker-grid').style.getPropertyValue('--variant-track');
    expect(track).toContain('var(--compared-fonts)');
    expect(track).not.toMatch(/^\d/);

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(grid.style.getPropertyValue('--compared-fonts')).toBe('1');
    fireEvent.click(fontChip('libertinus-math'));
    expect(grid.style.getPropertyValue('--compared-fonts')).toBe('0');
  }, 15000);

  it('sizes a card from the fonts it holds, so a card with one is narrower than a card with four', async () => {
    const view = render(<SymbolPickerPage />);
    const singleCodepoint = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(singleCodepoint));
    expect(cardFor(view.container, singleCodepoint)!.style.getPropertyValue('--card-fonts')).toBe('1');

    await showOnly(view.container, formatCodepoint(SHARED));
    const shared = cardFor(view.container, SHARED)!;
    expect(shared.style.getPropertyValue('--card-fonts')).toBe(String(fontSlugs.length));

    // The card's width is that count times one font's column, so the two cards
    // above cannot come out the same width.
    const width = ruleFor('.symbol-picker-card').style.getPropertyValue('width');
    expect(width).toContain('var(--card-fonts)');
    expect(width).toContain('var(--variant-track)');
    expect(width).not.toMatch(/\d+rem\s*;/);
    expect(ruleFor('.symbol-picker-variants').style.getPropertyValue('grid-template-columns'))
      .toBe('repeat(var(--card-fonts), minmax(0, 1fr))');
  }, 15000);

  it('draws cards as a wrapping wall of one height, so the titles line up', () => {
    const view = render(<SymbolPickerPage />);
    const grid = listOf(view.container);
    const wall = getComputedStyle(grid);
    expect(wall.display).toBe('flex');
    expect(wall.flexWrap).toBe('wrap');
    // A line of cards shares the height of its tallest card, and no card opts out.
    expect(wall.alignItems).toBe('stretch');
    for (const card of cards(view.container).slice(0, 5)) {
      expect(getComputedStyle(card).alignSelf).toBe('auto');
    }
  }, 15000);

  it('shows a codepoint one font can draw as a card of one, with no empty placeholder', async () => {
    const view = render(<SymbolPickerPage />);
    const only = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(only));

    const card = cardFor(view.container, only)!;
    expect(variants(card)).toHaveLength(1);
    expect(variantFor(card, 'libertinus-math')).toBeInTheDocument();
    expect(within(card).queryByText(familyOf('noto-sans-symbols-2'))).toBeNull();
  }, 15000);

  it('groups a shared codepoint into one card of one variant per font', async () => {
    const view = render(<SymbolPickerPage />);
    expect(glyphsByCodepoint.get(SHARED)).toEqual(fontSlugs);
    await showOnly(view.container, formatCodepoint(SHARED));

    const card = cardFor(view.container, SHARED)!;
    expect(cards(view.container)).toHaveLength(1);
    expect(variants(card)).toHaveLength(fontSlugs.length);
    for (const slug of fontSlugs) {
      expect(variantFor(card, slug)).toBeInTheDocument();
    }
  }, 15000);

  it('toggles one font\'s copy of a shared codepoint without disturbing the other font', async () => {
    expect(selection).toEqual(expect.arrayContaining(fontSlugs.map((slug) => `${slug}:U+2666`)));
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));

    const card = cardFor(view.container, SHARED)!;
    const libertinus = variantFor(card, 'libertinus-math');
    const noto = variantFor(card, 'noto-sans-symbols-2');
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

  it('compares any number of fonts at once, and the grid follows the tick', async () => {
    const view = render(<SymbolPickerPage />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toEqual([]);
    for (const slug of fontSlugs) expect(fontChip(slug)).toBeChecked();

    const only = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(only));
    expect(variants(cardFor(view.container, only)!)).toHaveLength(1);

    fireEvent.click(fontChip('libertinus-math'));

    expect(fontChip('libertinus-math')).not.toBeChecked();
    expect(fontChip('noto-sans-symbols-2')).toBeChecked();
    expect(cardFor(view.container, only)).toBeNull();
    expect(listOf(view.container)).toHaveTextContent('No codepoints match this search.');

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(cards(view.container)).toEqual([]);
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
    const card = cardFor(view.container, SHARED)!;
    for (const slug of fontSlugs) {
      const variant = variantFor(card, slug);
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
    const variant = variantFor(cardFor(view.container, SHARED)!, 'libertinus-math');

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

    // A narrower card squeezes the samples rather than cutting them off, which
    // is what the minmax(0, 1fr) tracks and the flexible strip are for.
    expect(ruleFor('.symbol-picker-variants').style.getPropertyValue('grid-template-columns'))
      .toBe('repeat(var(--card-fonts), minmax(0, 1fr))');
    expect(getComputedStyle(sizes).maxWidth).toBe('100%');
  }, 15000);

  it('keeps the codepoint title readable in a narrow card', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));

    for (const card of cards(view.container)) {
      const title = within(card).getByRole('heading');
      // The codepoint, the name and the block each keep their own line when the
      // card is too narrow to hold them, rather than being cut off.
      expect(getComputedStyle(title).flexWrap).toBe('wrap');
      expect(getComputedStyle(title).overflow).not.toBe('hidden');
      for (const part of title.children) {
        expect(getComputedStyle(part).textOverflow).not.toBe('ellipsis');
      }
      expect(title.querySelector('.symbol-picker-codepoint')).not.toBeNull();
    }
  }, 15000);

  it('reviews the ticked symbols and drops the search on entry', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    fireEvent.click(reviewToggle());

    expect(searchBox()).toHaveValue('');
    expect(reviewToggle()).toBeChecked();
    expect(cards(view.container)).toHaveLength(tickedCodepoints());
    expect(listOf(view.container)).not.toHaveTextContent(/Showing /);

    fireEvent.click(variantFor(cardFor(view.container, SHARED)!, 'libertinus-math'));

    const card = cardFor(view.container, SHARED)!;
    expect(variants(card)).toHaveLength(1);
    expect(variantFor(card, 'noto-sans-symbols-2')).toBeInTheDocument();
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
  }, 15000);

  it('spans the compared fonts alone while reviewing, since the pool is font-specific', async () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    expect(cards(view.container)).toHaveLength(tickedCodepoints());

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(fontChip('noto-sans-symbols-2')).not.toBeChecked();
    expect(cards(view.container)).toHaveLength(tickedCodepoints('libertinus-math'));
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
      expect(variantFor(cardFor(view.container, SHARED)!, slug)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - fontsAtPlay} selected`);

    fireEvent.click(screen.getByRole('button', { name: 'Select shown' }));
    for (const slug of fontSlugs) {
      expect(variantFor(cardFor(view.container, SHARED)!, slug)).toHaveAttribute('aria-pressed', 'true');
    }
    expect(countOf(view.container)).toHaveTextContent(`${selection.length} selected`);
  }, 15000);

  it('returns the grid to the top of a fresh page when the search box changes', async () => {
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

  it('returns the grid to the top of a fresh page when the compared fonts change', () => {
    const view = render(<SymbolPickerPage />);
    growThePage(view.container);
    listOf(view.container).scrollTop = 512;

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, codepointsFor('libertinus-math')));
    expect(listOf(view.container).scrollTop).toBe(0);
  }, 15000);
});

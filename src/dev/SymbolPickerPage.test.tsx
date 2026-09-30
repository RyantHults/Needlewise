import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SymbolPickerPage from './SymbolPickerPage';
import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';

/**
 * The picker draws two vendored fonts over one codepoint space, so the pool is
 * addressed by "<font-slug>:U+XXXX" and never by the codepoint alone. Browsing
 * groups the codepoints into cards, and reviewing shows the ticked set as bare
 * marks; which fonts the grid holds is a multi-select rather than a filter, so
 * what is there is only there when a compared font can draw it.
 *
 * Every expectation below is derived from the generated candidates and the
 * committed selection, so curating the pool never has to edit these numbers.
 */
const candidates = candidatesAsset.candidates;
const fontFamilies = candidatesAsset.fonts;
const fontSlugs = Object.keys(fontFamilies);
// Annotated, because a selection that names no glyphs is a legal authored file
// and TypeScript reads its entries as `never`.
const selection: readonly string[] = selectionAsset.selection;

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

/** The ticked marks the review grid holds, which is one per ticked entry. */
const tickedMarks = (slug?: string): number => selection
  .filter((entry) => !slug || entry.startsWith(`${slug}:`)).length;

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
const PAGE = 600;

const shownLine = (shown: number, total: number): string => `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}.`;

/** The scroller, which is the codepoint wall while browsing and the mark grid while reviewing. */
const listOf = (container: HTMLElement, name = 'Codepoints'): HTMLElement =>
  within(container).getByRole('region', { name });
const countOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.symbol-picker-count')!;
const searchBox = (): HTMLInputElement => screen.getByLabelText('Search');
const fontChip = (slug: string): HTMLInputElement => screen.getByRole('checkbox', { name: new RegExp(familyOf(slug)) });
const reviewToggle = (): HTMLInputElement => screen.getByRole('checkbox', { name: /Selected only/ });

const cards = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.symbol-picker-group')];
const marks = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.symbol-picker-mark')];
const expanderFor = (card: HTMLElement): HTMLButtonElement => card.querySelector<HTMLButtonElement>('.symbol-picker-expander')!;
const detailFor = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>('.symbol-picker-detail')!;
const detailVariants = (card: HTMLElement): HTMLElement[] => [...card.querySelectorAll<HTMLElement>('.symbol-picker-detail-variant')];

const cardFor = (container: HTMLElement, codepoint: number): HTMLElement | null =>
  cards(container).find((card) => {
    const mark = card.querySelector('.symbol-picker-mark');
    return mark?.getAttribute('title')?.includes(` · ${formatCodepoint(codepoint)} · `) === true;
  }) ?? null;

/**
 * The mark for one font at one codepoint, found by the description it carries.
 * A collapsed group shows no codepoint of its own, so the description is where a
 * mark says what it is in either mode.
 */
const markFor = (container: HTMLElement, codepoint: number, slug: string): HTMLElement => {
  const found = marks(container).filter((mark) => {
    const description = mark.getAttribute('title') ?? '';
    return description.includes(` · ${formatCodepoint(codepoint)} · `) && description.includes(familyOf(slug));
  });
  expect(found).toHaveLength(1);
  return found[0];
};

/** Open a group's details and return it, which is where the detail lives. */
const openDetails = (card: HTMLElement): HTMLElement => {
  const expander = expanderFor(card);
  if (expander.getAttribute('aria-expanded') === 'false') fireEvent.click(expander);
  return card;
};

/** The variant a codepoint holds for one font, found by the family name printed under its glyph. */
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

/** A declared length in px, whether the stylesheet wrote it in rem or in px. */
const toPx = (value: string): number => {
  const size = Number.parseFloat(value);
  return Number.isNaN(size) ? 0 : value.trim().endsWith('rem') ? size * 16 : size;
};

/** The border a rule declares, read from the declaration because jsdom misreads a var() colour. */
const borderWidth = (selector: string): number => {
  const declared = ruleFor(selector).style;
  const found = /([\d.]+)px/.exec(declared.getPropertyValue('border'))
    ?? /([\d.]+)px/.exec(declared.getPropertyValue('borderTopWidth'));
  return found ? Number.parseFloat(found[1]) : 0;
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

/** The samples, at the sizes a chart draws them. */
const SAMPLE_SIZES = [8, 16, 24];

describe('SymbolPickerPage', () => {
  it('lists codepoints in ascending order, one group per codepoint', () => {
    const view = render(<SymbolPickerPage />);
    const listed = cards(view.container);
    expect(listed).toHaveLength(PAGE);
    expect(listOf(view.container)).toHaveTextContent(shownLine(PAGE, allCodepoints.length));

    // The order is readable from the mark descriptions, since a collapsed group
    // shows no codepoint of its own.
    const codepoints = listed.map((card) => Number.parseInt(
      /· (U\+[0-9A-F]{4}) · /.exec(card.querySelector('.symbol-picker-mark')!.getAttribute('title')!)![1].slice(2),
      16
    ));
    expect(codepoints).toEqual([...codepoints].sort((a, b) => a - b));
    expect(new Set(codepoints).size).toBe(codepoints.length);

    for (const card of listed) {
      const codepoint = codepoints[listed.indexOf(card)];
      // A group holds one mark per compared font that can draw the codepoint.
      expect(marks(card)).toHaveLength(glyphsByCodepoint.get(codepoint)!.length);
    }
  }, 15000);

  it('turns the layout on the number of compared fonts rather than a fixed column count', () => {
    const view = render(<SymbolPickerPage />);
    const grid = listOf(view.container);
    expect(grid.style.getPropertyValue('--compared-fonts')).toBe(String(fontSlugs.length));

    // The count is what sets the width of one font's column, so a stylesheet
    // that hardcoded the column would leave nothing here to turn on.
    for (const track of ['--mark-track', '--detail-track']) {
      const declared = ruleFor('.symbol-picker-grid').style.getPropertyValue(track);
      expect(declared).toContain('var(--compared-fonts)');
      expect(declared).not.toMatch(/^\d/);
    }

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(grid.style.getPropertyValue('--compared-fonts')).toBe('1');
    fireEvent.click(fontChip('libertinus-math'));
    expect(grid.style.getPropertyValue('--compared-fonts')).toBe('0');
  }, 15000);

  it('sizes a group from the fonts it holds, so a group of one is narrower than a group of four', async () => {
    const view = render(<SymbolPickerPage />);
    const singleCodepoint = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(singleCodepoint));
    expect(cardFor(view.container, singleCodepoint)!.style.getPropertyValue('--group-fonts')).toBe('1');

    await showOnly(view.container, formatCodepoint(SHARED));
    const shared = cardFor(view.container, SHARED)!;
    expect(shared.style.getPropertyValue('--group-fonts')).toBe(String(fontSlugs.length));

    // A closed group is that count times one mark's track, so the two groups
    // above cannot come out the same width.
    const width = ruleFor('.symbol-picker-group').style.getPropertyValue('width');
    expect(width).toContain('var(--group-fonts)');
    expect(width).toContain('var(--mark-track)');
    expect(width).not.toMatch(/^\d+rem\s*;/);
    // An open group takes the width its details need instead.
    const openWidth = ruleFor('.symbol-picker-group.is-open').style.getPropertyValue('width');
    expect(openWidth).toContain('var(--detail-track)');
    // One mark's track against one detail's column, so a closed group is a third
    // the width of the group it opens into.
    expect(toPx(/([\d.]+rem)/.exec(ruleFor('.symbol-picker-grid').style.getPropertyValue('--mark-track'))![1]))
      .toBeLessThan(toPx(/([\d.]+rem)/.exec(ruleFor('.symbol-picker-grid').style.getPropertyValue('--detail-track'))![1]));
  }, 15000);

  it('draws the wall as a wrapping flex line of groups', () => {
    const view = render(<SymbolPickerPage />);
    const wall = getComputedStyle(listOf(view.container));
    expect(wall.display).toBe('flex');
    expect(wall.flexWrap).toBe('wrap');
  }, 15000);

  it('shows a collapsed group as its marks alone, with no text and no previews', () => {
    const view = render(<SymbolPickerPage />);
    for (const card of cards(view.container)) {
      expect(expanderFor(card).getAttribute('aria-expanded')).toBe('false');
      // Nothing but the marks is in the markup, so there is no hidden text for a
      // magnifier or a text selection to land on: no codepoint, name, block, font
      // name or samples exist while the group is closed.
      expect(card.querySelector('.symbol-picker-detail, .symbol-picker-codepoint, .symbol-picker-detail-name, .symbol-picker-detail-block, .symbol-picker-font-name, .symbol-picker-sizes, .symbol-picker-glyph, b')).toBeNull();
      for (const mark of marks(card)) {
        expect(mark.children).toHaveLength(0);
        expect([...mark.textContent!]).toHaveLength(1);
      }
    }
  }, 15000);

  it('nests no control inside another, and keeps the mark as the tick target', () => {
    const view = render(<SymbolPickerPage />);
    // A button cannot hold a button: the group holds its marks and its expander
    // side by side, so the tick target is the mark and nothing wraps it.
    for (const button of view.container.querySelectorAll('button')) {
      expect(button.querySelector('button')).toBeNull();
    }
    const card = cardFor(view.container, SHARED) ?? cards(view.container)[0];
    expect(marks(card).length).toBeGreaterThan(0);
    expect(expanderFor(card).querySelector('.symbol-picker-mark')).toBeNull();
  }, 15000);

  it('expands a group behind its expander without touching the selection', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const card = cardFor(view.container, SHARED)!;
    const expander = expanderFor(card);

    expect(expander).toHaveAttribute('aria-expanded', 'false');
    // The expander names the panel it will show, which is not in the markup yet.
    expect(expander.getAttribute('aria-controls')).toMatch(/^symbol-picker-detail-/);
    expect(card.querySelector('.symbol-picker-detail')).toBeNull();
    const before = countOf(view.container).textContent;

    fireEvent.click(expander);

    // The details are there, the panel is the one the expander named, and the
    // pool is exactly as it was.
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    expect(detailFor(card)).toBeInTheDocument();
    expect(detailFor(card).id).toBe(expander.getAttribute('aria-controls'));
    expect(detailFor(card).querySelector('.symbol-picker-codepoint')).toHaveTextContent(formatCodepoint(SHARED));
    expect(countOf(view.container).textContent).toBe(before);
    for (const slug of fontSlugs) {
      expect(markFor(view.container, SHARED, slug)).toHaveAttribute('aria-pressed', 'true');
    }

    fireEvent.click(expander);

    expect(expander).toHaveAttribute('aria-expanded', 'false');
    expect(card.querySelector('.symbol-picker-detail')).toBeNull();
  }, 15000);

  it('puts the details of a shared codepoint side by side, one per compared font', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const card = openDetails(cardFor(view.container, SHARED)!);

    const detail = detailFor(card);
    expect(within(detail).getByRole('heading')).toHaveTextContent(formatCodepoint(SHARED));
    expect(detailVariants(card).map((variant) => variant.querySelector('.symbol-picker-font-name')?.textContent))
      .toEqual(fontSlugs.map(familyOf));
    for (const variant of detailVariants(card)) {
      const samples = [...variant.querySelectorAll<HTMLElement>('.symbol-picker-sizes b')];
      expect(samples.map((sample) => sample.style.fontSize)).toEqual(['8px', '16px', '24px']);
    }
  }, 15000);

  it('shows a codepoint one font can draw as a group of one mark, with no empty placeholder', async () => {
    const view = render(<SymbolPickerPage />);
    const only = exclusiveTo('libertinus-math');
    await showOnly(view.container, formatCodepoint(only));

    const card = cardFor(view.container, only)!;
    expect(marks(card)).toHaveLength(1);
    expect(markFor(view.container, only, 'libertinus-math')).toBeInTheDocument();
    expect(marks(card)[0].getAttribute('title')).not.toContain(familyOf('noto-sans-symbols-2'));
  }, 15000);

  it('groups a shared codepoint into one group of adjacent marks, one per font', async () => {
    const view = render(<SymbolPickerPage />);
    expect(glyphsByCodepoint.get(SHARED)).toEqual(fontSlugs);
    await showOnly(view.container, formatCodepoint(SHARED));

    expect(cards(view.container)).toHaveLength(1);
    const card = cards(view.container)[0];
    // The variants of one codepoint are neighbours, so they can be compared in
    // place rather than found on separate cards.
    const inGroup = [...card.querySelectorAll('.symbol-picker-group-marks .symbol-picker-mark')];
    expect(inGroup).toHaveLength(fontSlugs.length);
    expect(inGroup.map((mark) => mark.getAttribute('title')?.split(' · ')[0])).toEqual(fontSlugs.map(familyOf));
  }, 15000);

  it('toggles one font\'s mark of a shared codepoint without disturbing the other font\'s', async () => {
    expect(selection).toEqual(expect.arrayContaining(fontSlugs.map((slug) => `${slug}:U+2666`)));
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));

    const libertinus = markFor(view.container, SHARED, 'libertinus-math');
    const noto = markFor(view.container, SHARED, 'noto-sans-symbols-2');
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
    expect(marks(cardFor(view.container, only)!)).toHaveLength(1);

    fireEvent.click(fontChip('libertinus-math'));

    expect(fontChip('libertinus-math')).not.toBeChecked();
    expect(fontChip('noto-sans-symbols-2')).toBeChecked();
    expect(cardFor(view.container, only)).toBeNull();
    expect(listOf(view.container)).toHaveTextContent('No codepoints match this search.');

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(cards(view.container)).toEqual([]);
    expect(listOf(view.container)).toHaveTextContent('No fonts are being compared.');
  }, 15000);

  it('previews every font in its own face, on the wall and in the details', async () => {
    const view = render(<SymbolPickerPage />);
    const faces = view.container.querySelector('style')!.textContent ?? '';
    for (const slug of fontSlugs) {
      expect(faces).toMatch(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${slug}"[^}]*url\\("/__symbols/font/${slug}\\.ttf"\\)`));
    }
    expect(faces.match(/@font-face/g)).toHaveLength(fontSlugs.length);

    await showOnly(view.container, formatCodepoint(SHARED));
    const card = openDetails(cardFor(view.container, SHARED)!);
    for (const slug of fontSlugs) {
      const face = `"${slug}", serif`;
      // The mark on the wall, and the specimen in the details behind it, are the
      // same glyph drawn in the same font.
      const mark = markFor(view.container, SHARED, slug);
      expect(mark).toHaveTextContent(String.fromCodePoint(SHARED));
      expect(mark).toHaveStyle({ fontFamily: face });
      expect(mark).toHaveAttribute('aria-label', expect.stringContaining(familyOf(slug)));

      const variant = detailVariants(card)
        .find((one) => one.querySelector('.symbol-picker-font-name')?.textContent === familyOf(slug))!;
      const specimen = variant.querySelector<HTMLElement>('.symbol-picker-specimen')!;
      const glyph = specimen.querySelector<HTMLElement>('.symbol-picker-glyph')!;
      expect(glyph).toHaveTextContent(String.fromCodePoint(SHARED));
      expect(glyph).toHaveStyle({ fontFamily: face });
      const samples = [...specimen.querySelectorAll<HTMLElement>('.symbol-picker-sizes b')];
      expect(samples.map((sample) => sample.style.fontFamily)).toEqual([face, face, face]);
      expect(samples.map((sample) => sample.style.fontSize)).toEqual(['8px', '16px', '24px']);
    }
  }, 15000);

  it('keeps the sizes beside the glyph in one row, and that row inside the detail', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const card = openDetails(cardFor(view.container, SHARED)!);
    const variant = detailVariants(card)[0];

    // The glyph and the strip share one row, and the name is not in it. A strip
    // stacked under the glyph would be a child of the variant instead of the
    // specimen, and one stacked inside the specimen would stack the row.
    const specimen = variant.querySelector<HTMLElement>('.symbol-picker-specimen')!;
    expect([...specimen.children].map((child) => child.className)).toEqual([
      'symbol-picker-glyph',
      'symbol-picker-sizes'
    ]);
    const row = getComputedStyle(specimen);
    expect(row.display).toBe('flex');
    expect(row.flexDirection).toBe('row');
    expect(row.alignItems).toBe('flex-end');

    // The glyph holds its place in the row and the strip is what narrows, so a
    // detail cannot be pushed wider than its column by putting the two side by
    // side: that would trade the height it saves for codepoints per row.
    const glyph = specimen.querySelector<HTMLElement>('.symbol-picker-glyph')!;
    const sizes = specimen.querySelector<HTMLElement>('.symbol-picker-sizes')!;
    expect(getComputedStyle(glyph).flex).toBe('0 0 auto');
    expect(getComputedStyle(sizes).flex).toBe('0 1 auto');
    expect(getComputedStyle(sizes).minWidth).toBe('0px');

    // The row has to fit one column of the detail, measured from the stylesheet's
    // own numbers: a sample is never wider than the font size it is drawn at, so
    // the three of them bound the strip, and the rest is the glyph, the gap and
    // the variant's own box.
    const track = toPx(/([\d.]+rem)/.exec(ruleFor('.symbol-picker-grid').style.getPropertyValue('--detail-track'))![1]);
    const strip = SAMPLE_SIZES.reduce((total, size) => total + size, 0)
      + 2 * toPx(getComputedStyle(sizes).gap)
      + toPx(getComputedStyle(sizes).paddingLeft) + toPx(getComputedStyle(sizes).paddingRight)
      + 2 * borderWidth('.symbol-picker-sizes');
    const needed = toPx(getComputedStyle(glyph).minWidth)
      + toPx(row.gap)
      + strip
      + toPx(getComputedStyle(variant).paddingLeft) + toPx(getComputedStyle(variant).paddingRight)
      + 2 * borderWidth('.symbol-picker-detail-variant');
    expect(needed).toBeLessThanOrEqual(track);
  }, 15000);

  it('sizes the glyph and its size strip from the samples, so the largest one is not clipped', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const variant = detailVariants(openDetails(cardFor(view.container, SHARED)!))[0];

    const sizes = variant.querySelector<HTMLElement>('.symbol-picker-sizes')!;
    const samples = [...sizes.querySelectorAll<HTMLElement>('b')];
    const largest = Math.max(...samples.map((sample) => Number.parseFloat(sample.style.fontSize)));
    expectNoClipping(sizes, largest);
    // The samples are laid out at the sizes a chart uses, so the box is taller
    // than a fixed strip once it is sized from them.
    expect(largest).toBe(24);

    const glyph = variant.querySelector<HTMLElement>('.symbol-picker-glyph')!;
    const glyphStyle = getComputedStyle(glyph);
    expect(glyphStyle.display).toBe('flex');
    expect(glyphStyle.height).toBe('auto');
    expect(glyphStyle.width).toBe('auto');
    expect(Number.parseFloat(glyphStyle.minHeight)).toBeGreaterThanOrEqual(largest);

    // Sharing a row with the glyph is where the squeeze happens, so the strip
    // is the part that narrows and the glyph is the part that holds its floor.
    expect(getComputedStyle(sizes).flex).toBe('0 1 auto');
    expect(getComputedStyle(sizes).minWidth).toBe('0px');
    expect(getComputedStyle(glyph).flex).toBe('0 0 auto');
    expect(Number.parseFloat(glyphStyle.minWidth)).toBeGreaterThanOrEqual(largest);

    // A narrower card squeezes the samples rather than cutting them off, which
    // is what the minmax(0, 1fr) tracks and the flexible strip are for.
    expect(ruleFor('.symbol-picker-detail-variants').style.getPropertyValue('grid-template-columns'))
      .toBe('repeat(var(--group-fonts), minmax(0, 1fr))');
    expect(getComputedStyle(sizes).maxWidth).toBe('100%');
  }, 15000);

  it('keeps the codepoint title readable when the group is open', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));

    for (const card of cards(view.container).map(openDetails)) {
      const title = within(detailFor(card)).getByRole('heading');
      // The codepoint, the name and the block each keep their own line when the
      // detail is too narrow to hold them, rather than being cut off.
      expect(getComputedStyle(title).flexWrap).toBe('wrap');
      expect(getComputedStyle(title).overflow).not.toBe('hidden');
      for (const part of title.children) {
        expect(getComputedStyle(part).textOverflow).not.toBe('ellipsis');
      }
      expect(title.querySelector('.symbol-picker-codepoint')).not.toBeNull();
    }
  }, 15000);

  it('reviews the ticked set as bare marks, keeping the description in hover text and the accessible name', () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());

    // Reviewing is the pool as marks and nothing else: no cards, and no text on
    // a mark but the glyph itself, which is the only text it can carry.
    expect(cards(view.container)).toEqual([]);
    expect(marks(view.container)).toHaveLength(selection.length);
    for (const mark of marks(view.container)) {
      expect(mark.children).toHaveLength(0);
      expect([...mark.textContent!]).toHaveLength(1);
      expect(mark.querySelector('.symbol-picker-codepoint, .symbol-picker-card-name, .symbol-picker-card-block, .symbol-picker-font-name, .symbol-picker-sizes, .symbol-picker-glyph, b')).toBeNull();
    }

    // What the hover text says is what the mark is called, so a screen reader
    // gets the whole description and the two marks one codepoint draws are told
    // apart even though nothing on the page says which font is which.
    for (const slug of fontSlugs) {
      const mark = markFor(view.container, SHARED, slug);
      const description = mark.getAttribute('title') ?? '';
      expect(description).toBe(`${familyOf(slug)} · ${formatCodepoint(SHARED)} · ${candidates.find((one) => one.codepoint === SHARED)!.name} · ${candidates.find((one) => one.codepoint === SHARED)!.block}`);
      expect(mark).toHaveAttribute('aria-label', description);
      expect(mark).toHaveTextContent(String.fromCodePoint(SHARED));
      expect(mark).toHaveStyle({ fontFamily: `"${slug}", serif` });
    }
    const named = screen.getAllByRole('button', { name: /black diamond suit/ });
    expect(named).toHaveLength(fontSlugs.length);
    expect(named.map((mark) => mark.getAttribute('aria-label'))).toEqual(
      fontSlugs.map((slug) => `${familyOf(slug)} · ${formatCodepoint(SHARED)} · black diamond suit · ${candidates.find((one) => one.codepoint === SHARED)!.block}`)
    );
  }, 15000);

  it('lays the review marks out as a grid of glyphs that are not clipped', () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    const grid = listOf(view.container, 'Ticked symbols');

    expect(getComputedStyle(grid).display).toBe('grid');
    expect(getComputedStyle(grid).gridTemplateColumns).toContain('auto-fill');
    for (const mark of marks(view.container).slice(0, 8)) {
      const style = getComputedStyle(mark);
      const size = Number.parseFloat(style.fontSize);
      // The mark is floored rather than squared off, so a descender or a tall
      // accent has room and nothing is shaved off it.
      expect(style.display).toBe('flex');
      expect(style.height).toBe('auto');
      expect(style.overflow).not.toBe('hidden');
      expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(size);
      expect(Number.parseFloat(style.minWidth)).toBeGreaterThanOrEqual(size);
    }
  }, 15000);

  it('returns to the codepoint groups when reviewing is switched off', async () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    expect(cards(view.container)).toEqual([]);

    fireEvent.click(reviewToggle());
    await showOnly(view.container, formatCodepoint(SHARED));

    expect(reviewToggle()).not.toBeChecked();
    // Browsing again: the marks are back inside a group, with an expander beside
    // them rather than loose in a grid.
    expect(listOf(view.container, 'Codepoints')).toBeTruthy();
    expect(marks(view.container).every((mark) => mark.closest('.symbol-picker-group') !== null)).toBe(true);
    const card = openDetails(cardFor(view.container, SHARED)!);
    expect(within(detailFor(card)).getByRole('heading')).toHaveTextContent(formatCodepoint(SHARED));
    expect(marks(card)).toHaveLength(fontSlugs.length);
    expect(detailVariants(card).map((variant) => variant.querySelector('.symbol-picker-font-name')?.textContent))
      .toEqual(fontSlugs.map(familyOf));
    expect(detailVariants(card).map((variant) => [...variant.querySelectorAll('.symbol-picker-sizes b')].length))
      .toEqual(fontSlugs.map(() => 3));
  }, 15000);

  it('reviews the ticked symbols and drops the search on entry', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    fireEvent.click(reviewToggle());

    expect(searchBox()).toHaveValue('');
    expect(reviewToggle()).toBeChecked();
    expect(marks(view.container)).toHaveLength(selection.length);
    // One page holds the whole pool, so a review of it needs no scrolling.
    expect(listOf(view.container, 'Ticked symbols')).not.toHaveTextContent(/Showing /);

    fireEvent.click(markFor(view.container, SHARED, 'libertinus-math'));

    expect(markFor(view.container, SHARED, 'noto-sans-symbols-2')).toBeInTheDocument();
    expect(marks(view.container)).toHaveLength(selection.length - 1);
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
  }, 15000);

  it('spans the compared fonts alone while reviewing, since the pool is font-specific', async () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    expect(marks(view.container)).toHaveLength(tickedMarks());

    fireEvent.click(fontChip('noto-sans-symbols-2'));

    expect(fontChip('noto-sans-symbols-2')).not.toBeChecked();
    // Nothing on a mark names its font, so the compared set is read from the
    // descriptions the marks carry.
    expect(marks(view.container)).toHaveLength(tickedMarks('libertinus-math'));
    for (const mark of marks(view.container)) {
      expect(mark.getAttribute('title')).toContain(familyOf('libertinus-math'));
    }
  }, 15000);

  it('clears the pool from the review grid, and says so', () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(reviewToggle());
    expect(marks(view.container)).toHaveLength(selection.length);

    fireEvent.click(screen.getByRole('button', { name: 'Clear shown' }));

    expect(marks(view.container)).toEqual([]);
    expect(listOf(view.container, 'Ticked symbols')).toHaveTextContent('Nothing is ticked in the fonts being compared.');
    expect(countOf(view.container)).toHaveTextContent('0 selected');
    expect(screen.getByRole('button', { name: 'Select shown' })).toBeDisabled();
  }, 15000);

  it('applies Select shown and Clear shown to every font at the listed codepoints', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, formatCodepoint(SHARED));
    const fontsAtPlay = glyphsByCodepoint.get(SHARED)!.length;

    fireEvent.click(screen.getByRole('button', { name: 'Clear shown' }));
    for (const slug of fontSlugs) {
      expect(markFor(view.container, SHARED, slug)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - fontsAtPlay} selected`);

    fireEvent.click(screen.getByRole('button', { name: 'Select shown' }));
    for (const slug of fontSlugs) {
      expect(markFor(view.container, SHARED, slug)).toHaveAttribute('aria-pressed', 'true');
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

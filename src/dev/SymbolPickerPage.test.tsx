import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SymbolPickerPage from './SymbolPickerPage';
import candidatesAsset from '../symbols/candidates.generated.json';
import selectionAsset from '../symbols/selection.json';

/**
 * The picker draws two vendored fonts over one codepoint space, so the pool is
 * addressed by "<font-slug>:U+XXXX" and never by the codepoint alone. Every
 * expectation below is derived from the generated candidates and the committed
 * selection, so curating the pool never has to edit these numbers.
 */
const candidates = candidatesAsset.candidates;
const fontFamilies = candidatesAsset.fonts;
const fontSlugs = Object.keys(fontFamilies);
const selection = selectionAsset.selection;

const familyOf = (slug: string): string => fontFamilies[slug as keyof typeof fontFamilies].family;
const candidateTotalFor = (slug?: string): number => candidates.filter((candidate) => !slug || candidate.font === slug).length;
const shownLine = (shown: number, total: number): string => `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}.`;

/** The picker paints one page of candidates and grows the page as the grid scrolls. */
const PAGE = 400;

const gridOf = (container: HTMLElement): HTMLElement => within(container).getByRole('tabpanel', { name: 'Candidates' });
const countOf = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.symbol-picker-count')!;
const searchBox = (): HTMLInputElement => screen.getByLabelText('Search');
const fontTab = (slug: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(familyOf(slug)) });
const allFontsTab = (): HTMLElement => screen.getByRole('tab', { name: /All fonts/ });

const cellsNamed = (container: HTMLElement, pattern: RegExp): HTMLElement[] => within(container).getAllByRole('button', { name: pattern });

/** Both fonts hold U+2666, so the two cells are told apart by the family in their meta line. */
const diamondCell = (container: HTMLElement, slug: string): HTMLElement => {
  const cells = cellsNamed(container, /black diamond suit/).filter((cell) => within(cell).queryByText(`U+2666 · ${familyOf(slug)}`));
  expect(cells).toHaveLength(1);
  return cells[0];
};

/** Type a query and wait for the deferred, filtered grid to settle. */
const showOnly = async (container: HTMLElement, query: string): Promise<void> => {
  fireEvent.change(searchBox(), { target: { value: query } });
  await waitFor(() => expect(countOf(container)).toHaveTextContent(/matching/));
};

/** The font family a cell's meta line credits, so a filtered grid can be identified without walking every cell. */
const cellsCrediting = (grid: HTMLElement, slug: string): HTMLElement[] => within(grid).queryAllByText(new RegExp(`· ${familyOf(slug)}$`));

const growThePage = (container: HTMLElement): void => {
  const grid = gridOf(container);
  fireEvent.scroll(grid);
  expect(gridOf(container)).toHaveTextContent(shownLine(PAGE * 2, candidates.length));
};

describe('SymbolPickerPage', () => {
  it('toggles one font\'s copy of a shared codepoint without disturbing the other font', async () => {
    expect(selection).toEqual(expect.arrayContaining(fontSlugs.map((slug) => `${slug}:U+2666`)));
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, 'U+2666');

    const libertinus = diamondCell(view.container, 'libertinus-math');
    const noto = diamondCell(view.container, 'noto-sans-symbols-2');
    expect(libertinus).toHaveAttribute('aria-pressed', 'true');
    expect(noto).toHaveAttribute('aria-pressed', 'true');
    expect(countOf(view.container)).toHaveTextContent(`${selection.length} selected`);

    fireEvent.click(libertinus);

    expect(libertinus).toHaveAttribute('aria-pressed', 'false');
    expect(noto).toHaveAttribute('aria-pressed', 'true');
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
    expect(countOf(view.container)).toHaveTextContent(`${familyOf('libertinus-math')} ${selection.filter((entry) => entry.startsWith('libertinus-math:')).length - 1}`);
    expect(countOf(view.container)).toHaveTextContent(`${familyOf('noto-sans-symbols-2')} ${selection.filter((entry) => entry.startsWith('noto-sans-symbols-2:')).length}`);
  });

  it('wires every font tab to the grid and walks the strip with the arrow, Home and End keys', () => {
    const view = render(<SymbolPickerPage />);
    const grid = gridOf(view.container);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(fontSlugs.length + 1);
    for (const tab of tabs) expect(document.getElementById(tab.getAttribute('aria-controls')!)).toBe(grid);
    expect(allFontsTab()).toHaveAttribute('aria-selected', 'true');
    expect(fontTab('libertinus-math')).toHaveAttribute('aria-selected', 'false');

    allFontsTab().focus();
    fireEvent.keyDown(allFontsTab(), { key: 'ArrowRight' });
    expect(fontTab('libertinus-math')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(fontTab('libertinus-math'));

    fireEvent.keyDown(fontTab('libertinus-math'), { key: 'ArrowRight' });
    expect(fontTab('noto-sans-symbols-2')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(fontTab('noto-sans-symbols-2'));

    fireEvent.keyDown(fontTab('noto-sans-symbols-2'), { key: 'ArrowLeft' });
    expect(fontTab('libertinus-math')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(fontTab('libertinus-math'));

    fireEvent.keyDown(fontTab('libertinus-math'), { key: 'End' });
    expect(fontTab('noto-sans-symbols-2')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(fontTab('noto-sans-symbols-2'));

    fireEvent.keyDown(fontTab('noto-sans-symbols-2'), { key: 'Home' });
    expect(allFontsTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(allFontsTab());
  });

  it('filters the grid to the font whose tab was clicked', async () => {
    const view = render(<SymbolPickerPage />);
    fireEvent.click(fontTab('libertinus-math'));
    await waitFor(() => expect(gridOf(view.container)).toHaveTextContent(shownLine(PAGE, candidateTotalFor('libertinus-math'))));
    expect(cellsCrediting(gridOf(view.container), 'libertinus-math')).toHaveLength(PAGE);
    expect(cellsCrediting(gridOf(view.container), 'noto-sans-symbols-2')).toEqual([]);

    fireEvent.click(fontTab('noto-sans-symbols-2'));
    await waitFor(() => expect(gridOf(view.container)).toHaveTextContent(shownLine(PAGE, candidateTotalFor('noto-sans-symbols-2'))));
    expect(cellsCrediting(gridOf(view.container), 'noto-sans-symbols-2')).toHaveLength(PAGE);
    expect(cellsCrediting(gridOf(view.container), 'libertinus-math')).toEqual([]);
    expect(allFontsTab()).toHaveAttribute('aria-selected', 'false');
  });

  it('reviews the selection across every font and drops the search and font filter on entry', async () => {
    const view = render(<SymbolPickerPage />);
    await showOnly(view.container, 'U+2666');
    fireEvent.click(fontTab('noto-sans-symbols-2'));
    const notoOnly = cellsNamed(view.container, /black diamond suit/);
    expect(notoOnly).toHaveLength(1);
    expect(within(notoOnly[0]).queryByText(`U+2666 · ${familyOf('noto-sans-symbols-2')}`)).not.toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /Selected only/ }));

    expect(searchBox()).toHaveValue('');
    expect(allFontsTab()).toHaveAttribute('aria-selected', 'true');
    expect(cellsNamed(view.container, /black diamond suit/)).toHaveLength(2);
    expect(gridOf(view.container)).not.toHaveTextContent(/Showing /);

    fireEvent.click(diamondCell(view.container, 'libertinus-math'));

    const remaining = cellsNamed(view.container, /black diamond suit/);
    expect(remaining).toHaveLength(1);
    expect(within(remaining[0]).queryByText(`U+2666 · ${familyOf('noto-sans-symbols-2')}`)).not.toBeNull();
    expect(countOf(view.container)).toHaveTextContent(`${selection.length - 1} selected`);
  });

  it('returns the grid to the top of a fresh page when the search box changes', async () => {
    const view = render(<SymbolPickerPage />);
    expect(gridOf(view.container)).toHaveTextContent(shownLine(PAGE, candidates.length));
    growThePage(view.container);
    gridOf(view.container).scrollTop = 512;

    const narrowed = 'miscellaneous symbols';
    const matches = candidates.filter((candidate) => candidate.name.includes(narrowed) || candidate.block.toLowerCase().includes(narrowed) || candidate.id.includes(narrowed));
    // More matches than one page, so a stale page size would paint them all.
    expect(matches.length).toBeGreaterThan(PAGE);
    await showOnly(view.container, narrowed);

    expect(gridOf(view.container)).toHaveTextContent(shownLine(PAGE, matches.length));
    expect(gridOf(view.container).scrollTop).toBe(0);
  });

  it('returns the grid to the top of a fresh page when the font tab changes', () => {
    const view = render(<SymbolPickerPage />);
    growThePage(view.container);
    gridOf(view.container).scrollTop = 512;

    fireEvent.click(fontTab('libertinus-math'));

    expect(gridOf(view.container)).toHaveTextContent(shownLine(PAGE, candidateTotalFor('libertinus-math')));
    expect(gridOf(view.container).scrollTop).toBe(0);
  });

  it('previews each candidate in its own vendored font', async () => {
    const view = render(<SymbolPickerPage />);
    const faces = view.container.querySelector('style')!.textContent ?? '';
    for (const slug of fontSlugs) {
      expect(faces).toMatch(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${slug}"[^}]*url\\("/__symbols/font/${slug}\\.ttf"\\)`));
    }
    expect(faces.match(/@font-face/g)).toHaveLength(fontSlugs.length);

    await showOnly(view.container, 'U+2666');
    for (const slug of fontSlugs) {
      const cell = diamondCell(view.container, slug);
      const face = `"${slug}", serif`;
      const glyph = within(cell).getByText(String.fromCodePoint(0x2666), { selector: '.symbol-picker-glyph' });
      expect(glyph).toHaveStyle({ fontFamily: face });
      const samples = [...cell.querySelectorAll<HTMLElement>('.symbol-picker-sizes b')];
      expect(samples.map((sample) => sample.style.fontFamily)).toEqual([face, face, face]);
      expect(samples.map((sample) => sample.style.fontSize)).toEqual(['8px', '16px', '24px']);
    }
  });
});

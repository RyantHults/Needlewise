import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogDefinition, CatalogRecord } from '../catalog';
import { ColorPickerModal } from './ColorPickerModal';
import { normalizeHexColor, ThreadColorPicker, type ThreadColorPickerProps } from './ThreadColorPicker';

const record = (sourceId: string, code: string, name: string, hex: `#${string}`): CatalogRecord => ({ sourceId, code, name, hex, rgb: [0, 0, 0] });
const makeCatalog = (catalogId: string, brandLabel: string, records: CatalogRecord[]): CatalogDefinition => {
  const byHex = new Map(records.map((item) => [item.hex.toUpperCase(), item]));
  return { association: { catalogId, brandLabel, colorCount: records.length }, records, compatibilityLabel: `${brandLabel}-compatible`, snapshot: { association: { catalogId, brandLabel, colorCount: records.length }, records }, search: (query, options = {}) => records.filter((item) => !query || `${item.name} ${item.code}`.toLowerCase().includes(query.toLowerCase())).slice(0, options.limit), getByHex: (hex) => byHex.get(hex.toUpperCase()), nearest: () => records[0] };
};
const red = record('a-red', '321', 'Red', '#CC0000');
const blue = record('a-blue', '797', 'Blue', '#0000CC');
const ruby = record('b-ruby', '9', 'Ruby', '#BB0000');
const jade = record('b-jade', '10', 'Jade', '#00AA55');
const catalogA = makeCatalog('catalog-a', 'Brand A', [red, blue]);
const catalogB = makeCatalog('catalog-b', 'Brand B', [ruby, jade]);

function renderPicker(overrides: Partial<ThreadColorPickerProps> = {}) {
  const onPickCatalogColor = vi.fn();
  const onPickCustomColor = vi.fn();
  const props: ThreadColorPickerProps = {
    catalogs: [catalogA, catalogB],
    defaultCatalogId: 'catalog-a',
    verb: 'Add',
    onPickCatalogColor,
    onPickCustomColor,
    customActionLabel: (hex, match) => match ? `Add ${match.name}` : hex ? `Add ${hex}` : 'Add custom color',
    ...overrides,
  };
  render(<ThreadColorPicker {...props} />);
  return { onPickCatalogColor, onPickCustomColor };
}
const selection = () => screen.getByRole('group', { name: 'Selected thread color' });

afterEach(() => vi.useRealTimers());

describe('normalizeHexColor', () => {
  it('expands and uppercases 3- and 6-digit values and rejects others', () => {
    expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    expect(normalizeHexColor(' c72b3b ')).toBe('#C72B3B');
    expect(normalizeHexColor('#abcd')).toBeUndefined();
  });
});

describe('ThreadColorPicker', () => {
  it('selects the default catalog and its first color', () => {
    renderPicker();
    expect(screen.getByRole('tab', { name: 'Brand A' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Brand B' })).toHaveAttribute('tabindex', '-1');
    expect(within(selection()).getByText('Red')).toBeInTheDocument();
    expect(within(selection()).getByText('Brand A · #321')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Red, color 321' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'editor-catalog-panel');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'editor-catalog-tab-catalog-a');
  });

  it('switching tabs resets the query and selects the new catalog\'s first color', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search Brand A catalog'), { target: { value: 'blue' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Brand B' }));
    expect(screen.getByRole('tab', { name: 'Brand B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Search Brand B catalog')).toHaveValue('');
    expect(within(selection()).getByText('Ruby')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Available thread colors' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('moves between tabs with the arrow, Home and End keys', () => {
    vi.useFakeTimers();
    renderPicker();
    const tabA = screen.getByRole('tab', { name: 'Brand A' });
    const tabB = screen.getByRole('tab', { name: 'Brand B' });
    fireEvent.keyDown(tabA, { key: 'ArrowRight' });
    act(() => { vi.runAllTimers(); });
    expect(tabB).toHaveAttribute('aria-selected', 'true');
    expect(tabB).toHaveFocus();
    fireEvent.keyDown(tabB, { key: 'ArrowRight' });
    act(() => { vi.runAllTimers(); });
    expect(tabA).toHaveAttribute('aria-selected', 'true');
    expect(tabA).toHaveFocus();
    fireEvent.keyDown(tabA, { key: 'End' });
    expect(tabB).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabB, { key: 'Home' });
    expect(tabA).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabA, { key: 'ArrowLeft' });
    expect(tabB).toHaveAttribute('aria-selected', 'true');
  });

  it('filters the grid by search and keeps the selection valid', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search Brand A catalog'), { target: { value: '797' } });
    const grid = screen.getByRole('list', { name: 'Available thread colors' });
    expect(within(grid).getAllByRole('button')).toHaveLength(1);
    expect(within(grid).getByRole('button', { name: 'Blue, color 797' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(selection()).getByText('Blue')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search Brand A catalog'), { target: { value: 'nothing' } });
    expect(screen.getByText('No matching colors.')).toBeInTheDocument();
    expect(within(selection()).getByText('No color selected')).toBeInTheDocument();
  });

  it('picks the selected catalog color through the verb button', () => {
    const { onPickCatalogColor } = renderPicker({ verb: 'Swap' });
    fireEvent.click(screen.getByRole('button', { name: 'Blue, color 797' }));
    fireEvent.click(screen.getByRole('button', { name: 'Swap Blue' }));
    expect(onPickCatalogColor).toHaveBeenCalledWith(blue, catalogA);
  });

  it('validates hex input and picks the custom color with its catalog match', () => {
    const { onPickCustomColor } = renderPicker();
    const hex = screen.getByLabelText('Hex color');
    const action = () => document.querySelector('.custom-color-action') as HTMLButtonElement;
    expect(hex).toHaveValue('#000000');
    expect(action()).toHaveAccessibleName('Add #000000');
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(screen.getByText('Enter a 3- or 6-digit hex color.')).toBeInTheDocument();
    expect(action()).toBeDisabled();
    expect(action()).toHaveAccessibleName('Add custom color');
    fireEvent.change(hex, { target: { value: 'cc0000' } });
    expect(screen.getByText('Use a three- or six-digit hex value.')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose custom color')).toHaveValue('#cc0000');
    expect(action()).toHaveAccessibleName('Add Red');
    fireEvent.click(action());
    expect(onPickCustomColor).toHaveBeenLastCalledWith('#CC0000', red, catalogA);
    fireEvent.change(hex, { target: { value: '#123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add #112233' }));
    expect(onPickCustomColor).toHaveBeenLastCalledWith('#112233', undefined, catalogA);
  });

  it('preselects the initial catalog, color and custom hex', () => {
    renderPicker({ initialCatalogId: 'catalog-b', initialColor: jade, initialCustomHex: '#00AA55' });
    expect(screen.getByRole('tab', { name: 'Brand B' })).toHaveAttribute('aria-selected', 'true');
    expect(within(selection()).getByText('Jade')).toBeInTheDocument();
    expect(screen.getByLabelText('Hex color')).toHaveValue('#00AA55');
    expect(within(selection()).getByRole('button', { name: 'Add Jade' })).toBeEnabled();
    expect(document.querySelector('.custom-color-action')).toHaveAccessibleName('Add Jade');
  });

  it('falls back to the default catalog when the initial one is not installed', () => {
    renderPicker({ initialCatalogId: 'missing' });
    expect(screen.getByRole('tab', { name: 'Brand A' })).toHaveAttribute('aria-selected', 'true');
  });

  it('reports the catalog as unavailable when none are installed', () => {
    renderPicker({ catalogs: [] });
    expect(screen.getByText('Catalog unavailable')).toBeInTheDocument();
    expect(screen.getByText('No color selected')).toBeInTheDocument();
  });
});

describe('ColorPickerModal', () => {
  it('renders the shell, focuses search, and closes via ×', () => {
    const onClose = vi.fn();
    render(<ColorPickerModal
      catalogs={[catalogA, catalogB]}
      defaultCatalogId="catalog-a"
      verb="Swap"
      onPickCatalogColor={vi.fn()}
      onPickCustomColor={vi.fn()}
      customActionLabel={() => 'Replace custom color'}
      eyebrow="Color Catalog"
      title="Swap Color"
      hint="Stitches using Red will be changed."
      notice="Could not swap."
      onClose={onClose}
    />);
    const dialog = screen.getByRole('dialog', { name: 'Swap Color' });
    expect(dialog).toHaveClass('catalog-dialog');
    expect(within(dialog).getByText('Color Catalog')).toHaveClass('section-label');
    expect(within(dialog).getByText('Stitches using Red will be changed.')).toHaveClass('modal-hint');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not swap.');
    expect(within(dialog).getByLabelText('Search Brand A catalog')).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close catalog dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the × when no catalog is installed', () => {
    render(<ColorPickerModal
      catalogs={[]}
      defaultCatalogId="catalog-a"
      verb="Add"
      onPickCatalogColor={vi.fn()}
      onPickCustomColor={vi.fn()}
      customActionLabel={() => 'Add custom color'}
      eyebrow="Color Catalog"
      title="Add a thread color"
      onClose={vi.fn()}
    />);
    expect(screen.getByRole('button', { name: 'Close catalog dialog' })).toHaveFocus();
  });
});

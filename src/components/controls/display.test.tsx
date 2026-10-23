import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { layerLimitMessage } from '../../domain';
import { BrandLink } from './BrandLink';
import { ErrorNotice, WarningNotice } from './Notice';
import { StorageFooter } from './StorageFooter';
import { SwatchSymbol, SYMBOL_VIEWBOX, SymbolTile } from './SwatchSymbol';

describe('notices', () => {
  it('announce errors as alerts and warnings as status', () => {
    render(<><ErrorNotice className="extra">Failed</ErrorNotice><WarningNotice>Careful</WarningNotice></>);

    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    expect(screen.getByRole('alert')).toHaveClass('modal-error', 'extra');
    expect(screen.getByRole('status')).toHaveTextContent('Careful');
    expect(screen.getByRole('status')).toHaveClass('modal-error');
  });
});

describe('page chrome', () => {
  it('links the brand home', () => {
    render(<MemoryRouter><BrandLink /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Needlewise home' })).toHaveAttribute('href', '/');
  });

  it('states where data lives', () => {
    render(<StorageFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Stored on this device · Works offline');
  });
});

describe('layerLimitMessage', () => {
  it('names the layer type', () => {
    expect(layerLimitMessage('stitch')).toBe('You already have 3 stitch layers.');
    expect(layerLimitMessage('specialty')).toBe('You already have 3 specialty layers.');
  });
});

describe('symbol rendering', () => {
  it('draws a tile from the sprite with the shared viewBox', () => {
    const { container } = render(<SymbolTile id="a" />);
    const svg = container.querySelector('svg')!;

    expect(svg).toHaveAttribute('viewBox', SYMBOL_VIEWBOX);
    expect(svg.querySelector('use')).toHaveAttribute('href', '#symbol-a');
  });

  it('inks a swatch symbol', () => {
    const { container } = render(<SwatchSymbol symbol="a" color="#000000" />);
    const span = container.querySelector('.palette-swatch-symbol') as HTMLElement;

    expect(span.style.color).not.toBe('');
    expect(span.querySelector('use')).toHaveAttribute('href', '#symbol-a');
  });
});

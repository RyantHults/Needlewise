import { render } from '@testing-library/react';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type ProjectThumbnailSummary } from '../persistence';
import { ProjectThumbnail } from './ProjectThumbnail';

const base: ProjectThumbnailSummary = {
  version: 2,
  revision: 1,
  columns: 2,
  rows: 1,
  palette: ['#123456', '#AA0000'],
  indices: Uint8Array.of(0, 1),
};

function renderThumbnail(thumbnail: unknown) {
  render(<ProjectThumbnail revision={1} width={2} height={1} thumbnail={thumbnail as ProjectThumbnailSummary} />);
  return document.querySelector('.project-gallery-thumbnail canvas');
}

describe('ProjectThumbnail', () => {
  it('renders a thumbnail with a canonical custom Aida background', () => {
    expect(renderThumbnail(base)).toBeInTheDocument();
  });

  it('renders a Uint16Array thumbnail for palettes beyond 256 colours', () => {
    const palette = Array.from({ length: 300 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`);
    expect(renderThumbnail({ ...base, palette, indices: Uint16Array.of(0, 299) })).toBeInTheDocument();
  });

  it('accepts typed-array indices created in another realm', () => {
    const indices = runInNewContext('Uint8Array.of(0, 1)') as Uint8Array;
    expect(indices).not.toBeInstanceOf(Uint8Array);
    expect(renderThumbnail({ ...base, indices })).toBeInTheDocument();
  });

  it.each([
    ['version 1 array', { ...base, version: 1, indices: [0, 1] }],
    ['plain array', { ...base, indices: [0, 1] }],
    ['wrong typed array width', { ...base, indices: Uint16Array.of(0, 1) }],
    ['wrong length', { ...base, indices: Uint8Array.of(0) }],
    ['out-of-range index', { ...base, indices: Uint8Array.of(0, 2) }],
  ])('falls back to the neutral preview for %s', (_name, thumbnail) => {
    expect(renderThumbnail(thumbnail)).toBeNull();
  });
});

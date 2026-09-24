import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectThumbnail } from './ProjectThumbnail';

describe('ProjectThumbnail', () => {
  it('renders a thumbnail with a canonical custom Aida background', () => {
    render(<ProjectThumbnail revision={1} width={2} height={1} thumbnail={{
      version: 1,
      revision: 1,
      columns: 2,
      rows: 1,
      palette: ['#123456', '#AA0000'],
      indices: [0, 1],
    }} />);

    expect(document.querySelector('.project-gallery-thumbnail canvas')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProjectMetadata } from '../persistence';
import { ProjectGallery } from './ProjectGallery';

const validThumbnail: NonNullable<ProjectMetadata['thumbnail']> = {
  version: 1,
  revision: 1,
  columns: 2,
  rows: 2,
  palette: ['#f3eee5', '#000000'],
  indices: [0, 1, 1, 0]
};

function project(
  id: string,
  title: string,
  width?: number,
  height?: number,
  updatedAt = Date.UTC(2026, 0, 15),
  thumbnail?: ProjectMetadata['thumbnail']
): ProjectMetadata {
  return {
    id,
    title,
    notes: '',
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt,
    revision: 1,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(thumbnail === undefined ? {} : { thumbnail })
  };
}

function editedDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

function renderGallery(projects: readonly ProjectMetadata[], deleteConfirmId?: string | null) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const onCreate = vi.fn();
  const onImport = vi.fn();
  const view = render(
    <ProjectGallery
      projects={projects}
      deleteConfirmId={deleteConfirmId}
      onOpen={onOpen}
      onDelete={onDelete}
      onCreate={onCreate}
      onImport={onImport}
    />
  );
  return { view, onOpen, onDelete, onCreate, onImport };
}

afterEach(() => vi.restoreAllMocks());

describe('ProjectGallery', () => {
  it('renders the Projects heading and sorts projects newest-first', () => {
    const older = project('older', 'Older pattern', 12, 10, Date.UTC(2026, 0, 10));
    const newer = project('newer', 'Newer pattern', 32, 18, Date.UTC(2026, 0, 20));
    renderGallery([older, newer]);

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    const cards = screen.getAllByRole('article');
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining(newer.title),
      expect.stringContaining(older.title)
    ]);
  });

  it('renders each exact dimension/date metadata row before its project name', () => {
    const projects = [
      project('one', 'Garden sampler', 24, 31, Date.UTC(2026, 1, 2)),
      project('two', 'Night sky', 80, 45, Date.UTC(2026, 10, 27))
    ];
    renderGallery(projects);

    const cards = screen.getAllByRole('article');
    const sortedProjects = [...projects].sort((left, right) => right.updatedAt - left.updatedAt);
    sortedProjects.forEach((currentProject, index) => {
      const card = cards[index];
      const expectedMetadata = `${currentProject.width} × ${currentProject.height} stitches | Edited ${editedDate(currentProject.updatedAt)}`;
      const metadata = within(card).getByText((_, element) => element?.textContent === expectedMetadata);
      const name = within(card).getByText(currentProject.title, { exact: true });

      expect(metadata).toBeInTheDocument();
      expect(name).toBeInTheDocument();
      expect(metadata.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
  });

  it('exposes each project metadata row as the open action accessible description', () => {
    const currentProject = project('described', 'Described project', 18, 27, Date.UTC(2026, 3, 9));
    renderGallery([currentProject]);

    const metadata = `18 × 27 stitches | Edited ${editedDate(currentProject.updatedAt)}`;
    const metadataRow = within(screen.getByRole('article')).getByText((_, element) => element?.textContent === metadata);
    const open = metadataRow.closest('button');
    expect(open).not.toBeNull();
    expect(open).toHaveAccessibleDescription(metadata);
    expect(open).toHaveAttribute('aria-describedby');
  });

  it('handles a lone UTF-16 surrogate in a project ID while preserving the open description', () => {
    const currentProject = project('surrogate-\uD800', 'Surrogate project', 18, 27, Date.UTC(2026, 3, 9));
    const metadata = `18 × 27 stitches | Edited ${editedDate(currentProject.updatedAt)}`;

    expect(() => renderGallery([currentProject])).not.toThrow();

    const card = screen.getByRole('article');
    const metadataRow = within(card).getByText((_, element) => element?.textContent === metadata);
    const open = metadataRow.closest('button');
    expect(metadataRow).toBeVisible();
    expect(open).not.toBeNull();
    expect(open).toHaveAccessibleDescription(metadata);
  });

  it('shows Size unavailable for legacy projects without dimensions', () => {
    renderGallery([project('legacy', 'Legacy pattern')]);

    expect(screen.getByText(`Size unavailable | Edited ${editedDate(Date.UTC(2026, 0, 15))}`)).toBeInTheDocument();
  });

  it('renders a neutral fallback without a thumbnail and draws a valid thumbnail on canvas', () => {
    const fallback = project('fallback', 'Fallback', 10, 10);
    const withThumbnail = project('thumbnail', 'With thumbnail', 20, 15, undefined, validThumbnail);
    const imageData = { data: new Uint8ClampedArray(16) };
    const context = {
      imageSmoothingEnabled: true,
      createImageData: vi.fn(() => imageData),
      putImageData: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    renderGallery([fallback, withThumbnail]);

    const cards = screen.getAllByRole('article');
    expect(within(cards[0]).getByText('✣')).toBeInTheDocument();
    expect(cards[0].querySelector('canvas')).not.toBeInTheDocument();
    expect(cards[1].querySelector('canvas')).toBeInTheDocument();
    expect(context.createImageData).toHaveBeenCalledWith(2, 2);
    expect(context.putImageData).toHaveBeenCalled();
  });

  it('opens the selected project', () => {
    const selected = project('selected', 'Selected project', 40, 22);
    const { onOpen } = renderGallery([selected]);
    const card = screen.getByRole('article');

    fireEvent.click(within(card).getByText(selected.title, { exact: true }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(selected);
  });

  it('opens from the visible card footer action without replacing the delete action', () => {
    const selected = project('footer-open', 'Footer project', 40, 22);
    const { onOpen, onDelete } = renderGallery([selected]);
    const card = screen.getByRole('article');

    fireEvent.click(within(card).getByText('Open →'));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(selected);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole('button', { name: 'Delete Footer project' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(selected);
  });

  it('uses the externally supplied delete confirmation ID and invokes onDelete', () => {
    const first = project('first', 'First', 8, 8);
    const second = project('second', 'Second', 9, 7);
    const { view, onDelete } = renderGallery([first, second]);

    expect(screen.getByRole('button', { name: 'Delete Second' })).toHaveTextContent('Delete');
    view.rerender(
      <ProjectGallery
        projects={[first, second]}
        deleteConfirmId={second.id}
        onOpen={vi.fn()}
        onDelete={onDelete}
        onCreate={vi.fn()}
        onImport={vi.fn()}
      />
    );

    const confirm = screen.getByRole('button', { name: 'Confirm delete Second' });
    expect(confirm).toHaveTextContent('Confirm delete?');
    fireEvent.click(confirm);

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(second);
  });

  it('invokes the create and import actions', () => {
    const { onCreate, onImport } = renderGallery([project('one', 'One', 5, 6)]);

    fireEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import project' }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('renders the empty state and its create/import actions', () => {
    const { onCreate, onImport } = renderGallery([]);

    expect(screen.getByRole('status')).toHaveTextContent('Your canvas is ready');
    expect(screen.getByText('Create a pattern from scratch or bring in a local project to get started.')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create your first pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import a project' }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledOnce();
  });
});

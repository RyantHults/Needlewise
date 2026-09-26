import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProjectFolder, type ProjectFolderAssignment, type ProjectMetadata } from '../persistence';
import { ProjectGallery } from './ProjectGallery';

vi.mock('./NewFolderModal', () => ({
  NewFolderModal: (props: { parentName: string | null; busy?: boolean; onSubmit: (name: string) => void; onClose: () => void }) => (
    <div data-testid="new-folder-modal">
      <span data-testid="new-folder-modal-parent">{props.parentName ?? '(top level)'}</span>
      <button type="button" onClick={() => props.onSubmit('Mock Folder')}>mock-submit</button>
      <button type="button" onClick={props.onClose}>mock-close</button>
    </div>
  )
}));

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

function folder(id: string, name: string, parentId: string | null = null): ProjectFolder {
  return { id, name, parentId, createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 1) };
}

function assignment(projectId: string, folderId: string): ProjectFolderAssignment {
  return { projectId, folderId };
}

function editedDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

interface RenderOptions {
  folders?: readonly ProjectFolder[];
  folderAssignments?: readonly ProjectFolderAssignment[];
  currentFolderId?: string | null;
  folderDeleteConfirmId?: string | null;
  withFolderHandlers?: boolean;
}

function renderGallery(projects: readonly ProjectMetadata[], deleteConfirmId?: string | null, options: RenderOptions = {}) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const onCreate = vi.fn();
  const onImport = vi.fn();
  const onNavigateFolder = vi.fn();
  const onCreateFolder = vi.fn();
  const onRenameFolder = vi.fn();
  const onDeleteFolder = vi.fn();
  const onMoveProject = vi.fn();
  const onMoveFolder = vi.fn();
  const withFolderHandlers = options.withFolderHandlers ?? true;
  const view = render(
    <ProjectGallery
      projects={projects}
      deleteConfirmId={deleteConfirmId}
      onOpen={onOpen}
      onDelete={onDelete}
      onCreate={onCreate}
      onImport={onImport}
      folders={options.folders}
      folderAssignments={options.folderAssignments}
      currentFolderId={options.currentFolderId}
      folderDeleteConfirmId={options.folderDeleteConfirmId}
      onNavigateFolder={withFolderHandlers ? onNavigateFolder : undefined}
      onCreateFolder={withFolderHandlers ? onCreateFolder : undefined}
      onRenameFolder={withFolderHandlers ? onRenameFolder : undefined}
      onDeleteFolder={withFolderHandlers ? onDeleteFolder : undefined}
      onMoveProject={withFolderHandlers ? onMoveProject : undefined}
      onMoveFolder={withFolderHandlers ? onMoveFolder : undefined}
    />
  );
  return { view, onOpen, onDelete, onCreate, onImport, onNavigateFolder, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveProject, onMoveFolder };
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

    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import Pattern' }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('renders the empty state and its create/import actions', () => {
    const { onCreate, onImport } = renderGallery([]);

    expect(screen.getByText('Your canvas is ready')).toBeInTheDocument();
    expect(screen.getByText('Start a new pattern from scratch or an image, or import a .needlewise archive.')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New Pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import Pattern' }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('hides header actions in the top-level empty state and shows exactly one New Pattern button', () => {
    renderGallery([]);

    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New Pattern' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Import Pattern' })).toHaveLength(1);
  });

  it('shows header actions when projects are present at the top level', () => {
    renderGallery([project('one', 'One', 5, 6)]);

    expect(screen.getByRole('button', { name: 'New Pattern' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import Pattern' })).toBeInTheDocument();
  });
});

describe('ProjectGallery folders', () => {
  it('renders top-level folders before projects and navigates on open', () => {
    const top = folder('top', 'Charts');
    const inFolder = project('in-folder', 'Inside', 10, 10);
    const atTop = project('at-top', 'Loose pattern', 10, 10);
    const { onNavigateFolder } = renderGallery([inFolder, atTop], null, {
      folders: [top],
      folderAssignments: [assignment('in-folder', 'top')]
    });

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Charts')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Loose pattern')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open folder Charts' }));
    expect(onNavigateFolder).toHaveBeenCalledWith('top');
  });

  it('shows a breadcrumb inside a folder and navigates back via it', () => {
    const top = folder('top', 'Charts');
    const { onNavigateFolder } = renderGallery([], null, {
      folders: [top],
      currentFolderId: 'top'
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Charts' })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Folder breadcrumb' });
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Projects' }));
    expect(onNavigateFolder).toHaveBeenCalledWith(null);
  });

  it('shows Parent and Child in the breadcrumb inside a subfolder', () => {
    const top = folder('top', 'Charts');
    const child = folder('child', 'Winter', 'top');
    const { onNavigateFolder } = renderGallery([], null, {
      folders: [top, child],
      currentFolderId: 'child'
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Winter' })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Folder breadcrumb' });
    expect(breadcrumb).toHaveTextContent('Projects › Charts › Winter');
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Charts' }));
    expect(onNavigateFolder).toHaveBeenCalledWith('top');
  });

  it('treats an unknown currentFolderId as the top level', () => {
    renderGallery([project('one', 'One', 5, 5)], null, { currentFolderId: 'missing' });

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Folder breadcrumb' })).not.toBeInTheDocument();
  });

  it('opens the New Folder modal from "New folder", and submitting it calls onCreateFolder then closes it', () => {
    const existing = folder('existing', 'Existing');
    const { onCreateFolder } = renderGallery([], null, { folders: [existing] });

    expect(screen.queryByTestId('new-folder-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    expect(screen.getByTestId('new-folder-modal')).toBeInTheDocument();
    expect(screen.getByTestId('new-folder-modal-parent')).toHaveTextContent('(top level)');

    fireEvent.click(screen.getByRole('button', { name: 'mock-submit' }));

    expect(onCreateFolder).toHaveBeenCalledOnce();
    expect(onCreateFolder).toHaveBeenCalledWith('Mock Folder', null);
    expect(screen.queryByTestId('new-folder-modal')).not.toBeInTheDocument();
  });

  it('passes the current folder as the modal parent when creating a subfolder', () => {
    const top = folder('top', 'Charts');
    const { onCreateFolder } = renderGallery([], null, { folders: [top], currentFolderId: 'top' });

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    expect(screen.getByTestId('new-folder-modal-parent')).toHaveTextContent('Charts');

    fireEvent.click(screen.getByRole('button', { name: 'mock-submit' }));
    expect(onCreateFolder).toHaveBeenCalledWith('Mock Folder', 'top');
  });

  it('closes the New Folder modal via its onClose without creating a folder', () => {
    const existing = folder('existing', 'Existing');
    const { onCreateFolder } = renderGallery([], null, { folders: [existing] });

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-close' }));

    expect(screen.queryByTestId('new-folder-modal')).not.toBeInTheDocument();
    expect(onCreateFolder).not.toHaveBeenCalled();
  });

  it('hides "New folder" inside a subfolder', () => {
    const top = folder('top', 'Charts');
    const child = folder('child', 'Winter', 'top');
    renderGallery([], null, { folders: [top, child], currentFolderId: 'child' });

    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
  });

  it('renames a folder on Enter', () => {
    const top = folder('top', 'Charts');
    const { onRenameFolder } = renderGallery([], null, { folders: [top] });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename folder Charts');
    fireEvent.change(input, { target: { value: 'Seasonal charts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameFolder).toHaveBeenCalledWith('top', 'Seasonal charts');
  });

  it('disables the drag handle while renaming a folder, so selecting text in the input cannot start a card drag', () => {
    const top = folder('top', 'Charts');
    renderGallery([], null, { folders: [top] });

    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(screen.getByLabelText('Rename folder Charts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeDisabled();
  });

  it('cancels a folder rename on Escape without calling onRenameFolder', () => {
    const top = folder('top', 'Charts');
    const { onRenameFolder } = renderGallery([], null, { folders: [top] });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename folder Charts');
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRenameFolder).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Rename folder Charts')).not.toBeInTheDocument();
    expect(screen.getByText('Charts')).toBeInTheDocument();
  });

  it('commits a folder rename only once when Enter is followed by a blur from the input unmounting', () => {
    const top = folder('top', 'Charts');
    const { onRenameFolder } = renderGallery([], null, { folders: [top] });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename folder Charts');
    fireEvent.change(input, { target: { value: 'Seasonal charts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(onRenameFolder).toHaveBeenCalledOnce();
    expect(onRenameFolder).toHaveBeenCalledWith('top', 'Seasonal charts');
  });

  it('does not call onRenameFolder when Escape is followed by a blur from the input unmounting', () => {
    const top = folder('top', 'Charts');
    const { onRenameFolder } = renderGallery([], null, { folders: [top] });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename folder Charts');
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(onRenameFolder).not.toHaveBeenCalled();
  });

  it('shows the folder delete confirm label and calls onDeleteFolder', () => {
    const top = folder('top', 'Charts');
    const { onDeleteFolder, view } = renderGallery([], null, { folders: [top] });

    const deleteButton = screen.getByRole('button', { name: 'Delete folder Charts' });
    fireEvent.click(deleteButton);
    expect(onDeleteFolder).toHaveBeenCalledWith(top);

    view.rerender(
      <ProjectGallery
        projects={[]}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
        onImport={vi.fn()}
        folders={[top]}
        folderDeleteConfirmId="top"
        onDeleteFolder={onDeleteFolder}
      />
    );
    const confirm = screen.getByRole('button', { name: 'Confirm delete folder Charts' });
    expect(confirm).toHaveTextContent('Confirm delete?');
  });

  it('renders a drag handle on every project and folder card, and no move-to select remains', () => {
    const top = folder('top', 'Charts');
    const atTop = project('at-top', 'Loose pattern', 10, 10);
    renderGallery([atTop], null, { folders: [top] });

    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Loose pattern' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Move .* to folder/)).not.toBeInTheDocument();
  });

  it('hides the move-up bar when no drag is active', () => {
    const top = folder('top', 'Charts');
    renderGallery([project('one', 'One', 5, 5)], null, { folders: [top], currentFolderId: 'top' });

    expect(screen.queryByText(/Drop here to move out/)).not.toBeInTheDocument();
  });

  it('does not show the move-up bar at the top level even conceptually (no currentFolder to move out of)', () => {
    renderGallery([project('one', 'One', 5, 5)]);
    expect(screen.queryByText(/Drop here to move out/)).not.toBeInTheDocument();
  });

  it('shows the most recently updated project (by updatedAt then revision) as the folder preview', () => {
    const top = folder('top', 'Charts');
    const child = folder('child', 'Winter', 'top');
    const older = project('older', 'Older', 10, 10, Date.UTC(2026, 0, 1), validThumbnail);
    const newer = project('newer', 'Newer', 20, 15, Date.UTC(2026, 0, 20), { ...validThumbnail, revision: 1 });
    const imageData = { data: new Uint8ClampedArray(16) };
    const context = {
      imageSmoothingEnabled: true,
      createImageData: vi.fn(() => imageData),
      putImageData: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

    renderGallery([older, newer], null, {
      folders: [top, child],
      folderAssignments: [assignment('older', 'top'), assignment('newer', 'child')]
    });

    const folderCard = screen.getByRole('article');
    expect(folderCard.querySelector('canvas')).toBeInTheDocument();
    expect(context.createImageData).toHaveBeenCalledWith(2, 2);
  });

  it('shows a neutral preview for an empty folder', () => {
    const top = folder('top', 'Charts');
    renderGallery([], null, { folders: [top] });

    const folderCard = screen.getByRole('article');
    expect(within(folderCard).getByText('✣')).toBeInTheDocument();
  });

  it('shows the folder meta text with pattern and subfolder counts', () => {
    const top = folder('top', 'Charts');
    const child = folder('child', 'Winter', 'top');
    const inTop = project('in-top', 'In top', 10, 10);
    const inChild = project('in-child', 'In child', 10, 10);
    renderGallery([inTop, inChild], null, {
      folders: [top, child],
      folderAssignments: [assignment('in-top', 'top'), assignment('in-child', 'child')]
    });

    expect(screen.getByText('2 patterns · 1 folder')).toBeInTheDocument();
  });

  it('shows the empty-folder message inside an empty folder without the whole-app empty state', () => {
    const top = folder('top', 'Charts');
    renderGallery([], null, { folders: [top], currentFolderId: 'top' });

    expect(screen.getByText(/This folder is empty/)).toBeInTheDocument();
    expect(screen.queryByText('Your canvas is ready')).not.toBeInTheDocument();
  });

  it('shows the whole-app empty state only at the top level with no projects and no folders', () => {
    renderGallery([]);
    expect(screen.getByText('Your canvas is ready')).toBeInTheDocument();
  });

  it('performs a keyboard drag (Space to pick up, ArrowDown to move, Space to drop) that moves a pattern into a folder', async () => {
    const top = folder('top', 'Charts');
    const atTop = project('at-top', 'Loose pattern', 10, 10);
    const { onMoveProject } = renderGallery([atTop], null, { folders: [top] });

    const folderArticle = screen.getByRole('button', { name: 'Open folder Charts' }).closest('article');
    const projectArticle = screen.getByRole('button', { name: 'Drag Loose pattern' }).closest('article');
    const projectHandle = screen.getByRole('button', { name: 'Drag Loose pattern' });
    expect(folderArticle).not.toBeNull();
    expect(projectArticle).not.toBeNull();

    const stubRect = (element: Element, rect: { top: number; left: number; width: number; height: number }): void => {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON() { return this; }
      } as DOMRect);
    };
    // The folder card sits above the project card, so ArrowUp should reach it.
    stubRect(projectArticle as Element, { top: 300, left: 0, width: 200, height: 200 });
    stubRect(folderArticle as Element, { top: 0, left: 0, width: 200, height: 200 });

    projectHandle.focus();
    fireEvent.keyDown(projectHandle, { code: 'Space' });
    // KeyboardSensor attaches its document-level keydown listener after a setTimeout(0).
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }));

    expect(onMoveProject).toHaveBeenCalledWith(atTop, 'top');
  });
});

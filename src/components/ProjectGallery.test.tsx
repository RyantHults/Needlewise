import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GalleryOrder, type ProjectFolder, type ProjectFolderAssignment, type ProjectMetadata, type ProjectOpened } from '../persistence';
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
  version: 2,
  revision: 1,
  columns: 2,
  rows: 2,
  palette: ['#f3eee5', '#000000'],
  indices: Uint8Array.of(0, 1, 1, 0)
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

function assignment(projectId: string, folderId: string, assignedAt = 0): ProjectFolderAssignment {
  return { projectId, folderId, assignedAt };
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
  galleryOrders?: readonly GalleryOrder[];
  projectOpens?: readonly ProjectOpened[];
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
  const onMoveProjects = vi.fn();
  const onMoveFolder = vi.fn();
  const onGroupProjects = vi.fn();
  const onDuplicateProjects = vi.fn();
  const onDeleteProjects = vi.fn();
  const onReorder = vi.fn();
  const element = (currentProjects: readonly ProjectMetadata[], currentOptions: RenderOptions) => {
    const withFolderHandlers = currentOptions.withFolderHandlers ?? true;
    return (
      <ProjectGallery
        projects={currentProjects}
        deleteConfirmId={deleteConfirmId}
        onOpen={onOpen}
        onDelete={onDelete}
        onCreate={onCreate}
        onImport={onImport}
        folders={currentOptions.folders}
        folderAssignments={currentOptions.folderAssignments}
        currentFolderId={currentOptions.currentFolderId}
        folderDeleteConfirmId={currentOptions.folderDeleteConfirmId}
        galleryOrders={currentOptions.galleryOrders}
        projectOpens={currentOptions.projectOpens}
        onNavigateFolder={withFolderHandlers ? onNavigateFolder : undefined}
        onCreateFolder={withFolderHandlers ? onCreateFolder : undefined}
        onRenameFolder={withFolderHandlers ? onRenameFolder : undefined}
        onDeleteFolder={withFolderHandlers ? onDeleteFolder : undefined}
        onMoveProjects={withFolderHandlers ? onMoveProjects : undefined}
        onMoveFolder={withFolderHandlers ? onMoveFolder : undefined}
        onGroupProjects={withFolderHandlers ? onGroupProjects : undefined}
        onReorder={onReorder}
        {...required()}
        onDuplicateProjects={onDuplicateProjects}
        onDeleteProjects={onDeleteProjects}
      />
    );
  };
  const view = render(element(projects, options));
  const rerender = (nextProjects: readonly ProjectMetadata[], nextOptions: RenderOptions = options) => view.rerender(element(nextProjects, nextOptions));
  return {
    view,
    rerender,
    onOpen,
    onDelete,
    onCreate,
    onImport,
    onNavigateFolder,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveProjects,
    onMoveFolder,
    onGroupProjects,
    onDuplicateProjects,
    onDeleteProjects,
    onReorder
  };
}

/** Places `element` for both box readings jsdom leaves at zero: its client rect, and its layout box inside a grid at the origin. */
function stubRect(element: Element, rect: { top: number; left: number; width: number; height: number }): void {
  for (const [name, value] of [['offsetLeft', rect.left], ['offsetTop', rect.top], ['offsetWidth', rect.width], ['offsetHeight', rect.height]] as const) {
    Object.defineProperty(element, name, { configurable: true, get: () => value });
  }
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
}

/** Picks up the item behind `handle` with Space, presses each arrow in turn, then drops it with Space. */
async function keyboardDrag(handle: HTMLElement, arrows: string | readonly string[]): Promise<void> {
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space' });
  // KeyboardSensor attaches its document-level keydown listener after a setTimeout(0).
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const arrow of typeof arrows === 'string' ? [arrows] : arrows) {
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: arrow, bubbles: true, cancelable: true })); });
  }
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })); });
}

const required = () => ({
  brand: <a href="/">Needlewise</a>,
  onDuplicateProjects: vi.fn(),
  onDeleteProjects: vi.fn(),
  onRenameProject: vi.fn()
});

beforeEach(() => localStorage.clear());
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

  it('renders each exact dimension/date metadata row with its project name', () => {
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
      expect(within(card).getByRole('button', { name: `Open ${currentProject.title}` })).toHaveAccessibleDescription(expectedMetadata);
      expect(within(card).getByText(currentProject.title, { exact: true })).toBeInTheDocument();
    });
  });

  it('exposes each project metadata row as the open action accessible description', () => {
    const currentProject = project('described', 'Described project', 18, 27, Date.UTC(2026, 3, 9));
    renderGallery([currentProject]);

    const metadata = `18 × 27 stitches | Edited ${editedDate(currentProject.updatedAt)}`;
    expect(screen.getByRole('button', { name: 'Open Described project' })).toHaveAccessibleDescription(metadata);
  });

  it('handles a lone UTF-16 surrogate in a project ID while preserving the open description', () => {
    const currentProject = project('surrogate-\uD800', 'Surrogate project', 18, 27, Date.UTC(2026, 3, 9));
    const metadata = `18 × 27 stitches | Edited ${editedDate(currentProject.updatedAt)}`;

    expect(() => renderGallery([currentProject])).not.toThrow();

    expect(screen.getByRole('button', { name: 'Open Surrogate project' })).toHaveAccessibleDescription(metadata);
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

    fireEvent.click(within(card).getByRole('button', { name: `Open ${selected.title}` }));

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

  it('duplicates the pattern from its card Duplicate button', () => {
    const selected = project('dup', 'Dup project', 40, 22);
    const { onDuplicateProjects } = renderGallery([selected]);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Dup project' }));

    expect(onDuplicateProjects).toHaveBeenCalledOnce();
    expect(onDuplicateProjects).toHaveBeenCalledWith([selected]);
  });

  it('disables the Duplicate button when the gallery is disabled', () => {
    render(<ProjectGallery projects={[project('dis', 'Dis project', 40, 22)]} disabled onOpen={vi.fn()} onDelete={vi.fn()} {...required()} onCreate={vi.fn()} onImport={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Duplicate Dis project' })).toBeDisabled();
  });

  describe('inline title rename', () => {
    function renderRenamable(onRenameProject = vi.fn(), onOpen = vi.fn()) {
      const selected = project('ren', 'Old title', 40, 22);
      render(<ProjectGallery projects={[selected]} onOpen={onOpen} onDelete={vi.fn()} {...required()} onRenameProject={onRenameProject} onCreate={vi.fn()} onImport={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Rename Old title' }));
      return { selected, onRenameProject, onOpen, input: screen.getByLabelText('Rename pattern Old title') as HTMLInputElement };
    }

    it('shows an input when the title is clicked, without opening the pattern', () => {
      const { onOpen, input } = renderRenamable();

      expect(input).toHaveValue('Old title');
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('commits the trimmed title on Enter and only once', () => {
      const { selected, onRenameProject, input } = renderRenamable();

      fireEvent.change(input, { target: { value: '  New title  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onRenameProject).toHaveBeenCalledOnce();
      expect(onRenameProject).toHaveBeenCalledWith(selected, 'New title');
    });
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
        {...required()}
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

  it('renders the brand and title in the header, with the sort and actions alongside', () => {
    renderGallery([project('one', 'One', 5, 6)], null, { folders: [folder('f', 'Charts')], currentFolderId: 'f' });

    const header = screen.getByRole('heading', { level: 1, name: 'Charts' }).closest('header') as HTMLElement;
    expect(within(header).getByRole('link', { name: 'Needlewise' })).toBeInTheDocument();
    expect(within(header).getByRole('navigation', { name: 'Folder breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort patterns' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Pattern' })).toBeInTheDocument();
  });

  it('keeps the brand but no actions in the top-level empty state', () => {
    renderGallery([]);

    const header = screen.getByRole('heading', { level: 1, name: 'Projects' }).closest('header') as HTMLElement;
    expect(within(header).getByRole('link', { name: 'Needlewise' })).toBeInTheDocument();
    expect(within(header).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Sort patterns' })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Rename Charts' }));
    const input = screen.getByLabelText('Rename folder Charts');
    fireEvent.change(input, { target: { value: 'Seasonal charts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameFolder).toHaveBeenCalledWith('top', 'Seasonal charts');
  });

  it('disables the drag handle while renaming a folder, so selecting text in the input cannot start a card drag', () => {
    const top = folder('top', 'Charts');
    renderGallery([], null, { folders: [top] });

    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Charts' }));

    expect(screen.getByLabelText('Rename folder Charts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeDisabled();
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
        {...required()}
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

  it('renders a drag handle on every project and folder card', () => {
    const top = folder('top', 'Charts');
    const atTop = project('at-top', 'Loose pattern', 10, 10);
    renderGallery([atTop], null, { folders: [top] });

    expect(screen.getByRole('button', { name: 'Drag Charts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Loose pattern' })).toBeInTheDocument();
  });

  it('shows a pattern in the folder preview as soon as it is put into the folder, ahead of older ones', () => {
    const top = folder('top', 'Charts');
    // Each pattern's thumbnail has its own column count, so the drawn image size names the pattern.
    const patterns = [1, 2, 3, 4, 5].map((columns) => project(`p${columns}`, `Pattern ${columns}`, columns, 1, undefined, {
      ...validThumbnail,
      columns,
      rows: 1,
      indices: new Uint8Array(columns)
    }));
    const imageData = { data: new Uint8ClampedArray(20) };
    const context = {
      imageSmoothingEnabled: true,
      createImageData: vi.fn(() => imageData),
      putImageData: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const props = { projects: patterns, folders: [top], onOpen: vi.fn(), onDelete: vi.fn(), onCreate: vi.fn(), ...required() };
    const fourInFolder = [1, 2, 3, 4].map((index) => assignment(`p${index}`, 'top', index * 10));
    const view = render(<ProjectGallery {...props} folderAssignments={fourInFolder} />);

    // Pattern 5 starts loose at the top level, then is put into the full folder.
    vi.mocked(context.createImageData).mockClear();
    view.rerender(<ProjectGallery {...props} folderAssignments={[...fourInFolder, assignment('p5', 'top', 50)]} />);

    expect(context.createImageData).toHaveBeenCalledWith(5, 1);
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
    const { onMoveProjects } = renderGallery([atTop], null, { folders: [top] });

    const folderArticle = screen.getByRole('button', { name: 'Open folder Charts' }).closest('article');
    const projectArticle = screen.getByRole('button', { name: 'Drag Loose pattern' }).closest('article');
    const projectHandle = screen.getByRole('button', { name: 'Drag Loose pattern' });
    expect(folderArticle).not.toBeNull();
    expect(projectArticle).not.toBeNull();

    // The folder card sits above the project card, so ArrowUp should reach it.
    stubRect(projectArticle as Element, { top: 300, left: 0, width: 200, height: 200 });
    stubRect(folderArticle as Element, { top: 0, left: 0, width: 200, height: 200 });

    await keyboardDrag(projectHandle, 'ArrowUp');

    expect(onMoveProjects).toHaveBeenCalledWith([atTop], 'top');
  });

  it('performs a keyboard drag that drops a pattern on another pattern to group them into a new folder', async () => {
    const dragged = project('dragged', 'Dragged pattern', 10, 10, Date.UTC(2026, 0, 10));
    const target = project('target', 'Target pattern', 10, 10, Date.UTC(2026, 0, 20));
    const { onGroupProjects, onMoveProjects } = renderGallery([dragged, target]);

    const draggedHandle = screen.getByRole('button', { name: 'Drag Dragged pattern' });
    stubRect(draggedHandle.closest('article') as Element, { top: 300, left: 0, width: 200, height: 200 });
    stubRect(screen.getByRole('button', { name: 'Drag Target pattern' }).closest('article') as Element, { top: 0, left: 0, width: 200, height: 200 });

    await keyboardDrag(draggedHandle, 'ArrowUp');

    expect(onGroupProjects).toHaveBeenCalledWith([dragged], target, null);
    expect(onMoveProjects).not.toHaveBeenCalled();
  });

  it('keeps the dragged pattern hidden in place until a group drop settles', async () => {
    const dragged = project('dragged', 'Dragged pattern', 10, 10, Date.UTC(2026, 0, 10));
    const target = project('target', 'Target pattern', 10, 10, Date.UTC(2026, 0, 20));
    const { onGroupProjects } = renderGallery([dragged, target]);
    let settle = () => {};
    onGroupProjects.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));

    const draggedHandle = screen.getByRole('button', { name: 'Drag Dragged pattern' });
    const draggedArticle = draggedHandle.closest('article') as HTMLElement;
    stubRect(draggedArticle, { top: 300, left: 0, width: 200, height: 200 });
    stubRect(screen.getByRole('button', { name: 'Drag Target pattern' }).closest('article') as Element, { top: 0, left: 0, width: 200, height: 200 });

    await keyboardDrag(draggedHandle, 'ArrowUp');

    expect(onGroupProjects).toHaveBeenCalledOnce();
    expect(draggedArticle).not.toBeVisible();

    await act(async () => { settle(); });

    expect(draggedArticle).toBeVisible();
  });
});

describe('ProjectGallery sorting and selection', () => {
  function dated(id: string, title: string, createdAt: number, updatedAt: number): ProjectMetadata {
    return { ...project(id, title, 10, 10, updatedAt), createdAt };
  }

  function cardTitles(): string[] {
    return screen.getAllByRole('article').map((card) => within(card).getByRole('button', { name: /^Rename / }).textContent ?? '');
  }

  function selectionBar(): HTMLElement {
    return screen.getByRole('toolbar', { name: 'Selected patterns' });
  }

  function handleCard(name: string): HTMLElement {
    return screen.getByRole('button', { name: `Drag ${name}` }).closest('article') as HTMLElement;
  }

  /** Stubs each named card side by side in one row, 200px wide with 20px between. */
  function layOutRow(names: readonly string[]): void {
    names.forEach((name, index) => stubRect(handleCard(name), { top: 0, left: index * 220, width: 200, height: 200 }));
  }

  const roses = dated('roses', 'Roses', 3, 30);
  const owl = dated('owl', 'Owl', 1, 20);
  const fox = dated('fox', 'Fox', 2, 10);

  it('offers the four sorts, defaults to recently modified, and remembers the choice', () => {
    const { view } = renderGallery([roses, owl]);

    const sort = screen.getByRole('combobox', { name: 'Sort patterns' });
    expect(sort).toHaveDisplayValue('Recently modified');
    expect(within(sort).getAllByRole('option').map((option) => option.textContent)).toEqual(['Recently modified', 'Recently opened', 'Recently created', 'Custom']);
    fireEvent.change(sort, { target: { value: 'created' } });
    view.unmount();

    renderGallery([roses, owl]);
    expect(screen.getByRole('combobox', { name: 'Sort patterns' })).toHaveDisplayValue('Recently created');
  });

  it('orders patterns by the chosen sort', () => {
    renderGallery([roses, owl, fox]);
    expect(cardTitles()).toEqual(['Roses', 'Owl', 'Fox']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort patterns' }), { target: { value: 'created' } });

    expect(cardTitles()).toEqual(['Roses', 'Fox', 'Owl']);
  });

  it('shows patterns opened most recently first under Recently opened', () => {
    renderGallery([roses, owl, fox], null, { projectOpens: [{ projectId: 'fox', openedAt: 9 }] });

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort patterns' }), { target: { value: 'opened' } });

    expect(cardTitles()).toEqual(['Fox', 'Roses', 'Owl']);
  });

  it('shows folders and patterns in their stored custom order', () => {
    renderGallery([roses, owl], null, {
      folders: [folder('gifts', 'Gifts')],
      galleryOrders: [{ levelId: 'root', keys: ['project:owl', 'folder:gifts', 'project:roses'] }]
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort patterns' }), { target: { value: 'custom' } });

    expect(screen.getAllByRole('article').map((card) => within(card).getByRole('button', { name: /^Rename / }).textContent)).toEqual(['Owl', 'Gifts', 'Roses']);
  });

  it('shows the selection bar with a count when patterns are ticked, and clears it', () => {
    renderGallery([roses, owl, fox]);
    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));

    expect(selectionBar()).toHaveTextContent('2 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Roses' })).toBeChecked();
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Clear selection' }));

    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Roses' })).not.toBeChecked();
  });

  it('offers no checkbox on folder cards', () => {
    renderGallery([roses], null, { folders: [folder('gifts', 'Gifts')] });

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('selects a range with shift-click in display order, and selects all', () => {
    renderGallery([roses, owl, fox, dated('wren', 'Wren', 0, 0)]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fox' }), { shiftKey: true });

    expect(selectionBar()).toHaveTextContent('3 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Wren' })).not.toBeChecked();
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Select all' }));
    expect(selectionBar()).toHaveTextContent('4 selected');
  });

  it('keeps the selection when Esc cancels a title rename, and clears it on a plain Esc', () => {
    renderGallery([roses, owl]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    fireEvent.click(screen.getByRole('button', { name: 'Rename Owl' }));
    fireEvent.keyDown(screen.getByLabelText('Rename pattern Owl'), { key: 'Escape' });

    expect(screen.queryByLabelText('Rename pattern Owl')).not.toBeInTheDocument();
    expect(selectionBar()).toHaveTextContent('1 selected');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
  });

  it('keeps the selection when Esc closes a dialog', () => {
    renderGallery([roses, owl]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Delete' }));

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete 1 pattern?' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(selectionBar()).toHaveTextContent('1 selected');
  });

  it('keeps the selection across a change of sort', () => {
    renderGallery([roses, owl]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort patterns' }), { target: { value: 'created' } });

    expect(selectionBar()).toHaveTextContent('1 selected');
  });

  it('clears the selection when navigating to another folder', () => {
    const gifts = folder('gifts', 'Gifts');
    const { rerender } = renderGallery([roses, owl], null, { folders: [gifts] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    rerender([roses, owl], { folders: [gifts], currentFolderId: 'gifts' });
    rerender([roses, owl], { folders: [gifts], currentFolderId: null });

    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Roses' })).not.toBeChecked();
  });

  it('counts only visible patterns when a selected one disappears', () => {
    const { rerender, onDuplicateProjects } = renderGallery([roses, owl]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));

    rerender([roses]);

    expect(selectionBar()).toHaveTextContent('1 selected');
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Duplicate' }));
    expect(onDuplicateProjects).toHaveBeenCalledWith([roses]);
  });

  it('does not tick patterns again when they come back into view', () => {
    const { rerender } = renderGallery([roses, owl, fox]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));

    rerender([fox]);
    rerender([roses, owl, fox]);

    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Roses' })).not.toBeChecked();
  });

  it('confirms bulk delete with the count and deletes the selection', () => {
    const { onDeleteProjects } = renderGallery([roses, owl, fox]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));

    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 2 patterns?' });
    expect(onDeleteProjects).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(onDeleteProjects).toHaveBeenCalledWith([roses, owl]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
  });

  it('cancels bulk delete without deleting', () => {
    const { onDeleteProjects } = renderGallery([roses, owl]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete 1 pattern?' })).getByRole('button', { name: 'Cancel' }));

    expect(onDeleteProjects).not.toHaveBeenCalled();
    expect(selectionBar()).toHaveTextContent('1 selected');
  });

  it('moves the selection through the folder picker', () => {
    const gifts = folder('gifts', 'Gifts');
    const winter = folder('winter', 'Winter', 'gifts');
    const { onMoveProjects } = renderGallery([roses, owl, fox], null, { folders: [winter, folder('archive', 'Archive'), gifts] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));

    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Move to folder…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move to folder' });
    const destinations = within(dialog).getAllByRole('button').filter((button) => !button.getAttribute('aria-label'));
    expect(destinations.map((button) => button.textContent)).toEqual(['Projects', 'Archive', 'Gifts', 'Winter']);
    expect(within(dialog).getByRole('button', { name: 'Projects' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gifts' }));

    expect(onMoveProjects).toHaveBeenCalledWith([roses, owl], 'gifts');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
  });

  it('disables the current folder in the folder picker', () => {
    const gifts = folder('gifts', 'Gifts');
    renderGallery([roses], null, { folders: [gifts], folderAssignments: [assignment('roses', 'gifts')], currentFolderId: 'gifts' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Move to folder…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move to folder' });

    expect(within(dialog).getByRole('button', { name: 'Gifts' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Projects' })).toBeEnabled();
  });

  it('duplicates the selection', () => {
    const { onDuplicateProjects } = renderGallery([roses, owl, fox]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fox' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));

    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Duplicate' }));

    expect(onDuplicateProjects).toHaveBeenCalledWith([roses, fox]);
    expect(screen.queryByRole('toolbar', { name: 'Selected patterns' })).not.toBeInTheDocument();
  });

  it('drags a selection onto a folder as one move', async () => {
    const { onMoveProjects } = renderGallery([roses, owl], null, { folders: [folder('gifts', 'Gifts')] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));
    stubRect(handleCard('Gifts'), { top: 0, left: 0, width: 200, height: 200 });
    stubRect(handleCard('Roses'), { top: 300, left: 0, width: 200, height: 200 });
    stubRect(handleCard('Owl'), { top: 300, left: 220, width: 200, height: 200 });

    await keyboardDrag(screen.getByRole('button', { name: 'Drag Owl' }), 'ArrowUp');

    expect(onMoveProjects).toHaveBeenCalledWith([roses, owl], 'gifts');
  });

  it('groups a selection onto an unselected pattern', async () => {
    const { onGroupProjects } = renderGallery([roses, owl, fox]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));
    stubRect(handleCard('Fox'), { top: 0, left: 0, width: 200, height: 200 });
    stubRect(handleCard('Roses'), { top: 300, left: 0, width: 200, height: 200 });
    stubRect(handleCard('Owl'), { top: 300, left: 220, width: 200, height: 200 });

    await keyboardDrag(screen.getByRole('button', { name: 'Drag Roses' }), 'ArrowUp');

    expect(onGroupProjects).toHaveBeenCalledWith([roses, owl], fox, null);
  });

  it('drags only an unselected pattern and keeps the selection', async () => {
    const { onGroupProjects } = renderGallery([roses, owl, fox]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Roses' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Owl' }));
    stubRect(handleCard('Roses'), { top: 0, left: 0, width: 200, height: 200 });
    stubRect(handleCard('Owl'), { top: 0, left: 220, width: 200, height: 200 });
    stubRect(handleCard('Fox'), { top: 300, left: 0, width: 200, height: 200 });

    await keyboardDrag(screen.getByRole('button', { name: 'Drag Fox' }), 'ArrowUp');

    expect(onGroupProjects).toHaveBeenCalledWith([fox], roses, null);
    expect(selectionBar()).toHaveTextContent('2 selected');
  });

  describe('custom order', () => {
    const a = dated('a', 'Alpha', 1, 1);
    const b = dated('b', 'Beta', 2, 2);
    const c = dated('c', 'Gamma', 3, 3);
    const arranged = { galleryOrders: [{ levelId: 'root', keys: ['project:a', 'project:b', 'project:c'] }] };

    function renderCustom(options: RenderOptions = arranged) {
      localStorage.setItem('needlewise-gallery-sort:v1', 'custom');
      const rendered = renderGallery([a, b, c], null, options);
      layOutRow(['Alpha', 'Beta', 'Gamma']);
      return rendered;
    }

    /** The empty slots a custom-order drag leaves in the grid, which assistive technology does not see. */
    function emptySlots(): number {
      const grid = screen.getAllByRole('article')[0].parentElement as HTMLElement;
      return grid.querySelectorAll(':scope > [aria-hidden="true"]').length;
    }

    /** The names on the cards a user can see, in order. */
    function cardNames(): string[] {
      return screen.getAllByRole('article').map((card) => within(card).getByRole('button', { name: /^Rename / }).textContent ?? '');
    }

    async function pickUp(handle: HTMLElement): Promise<void> {
      handle.focus();
      fireEvent.keyDown(handle, { code: 'Space' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('opens one empty slot per dragged card, and closes them when the drag is cancelled', async () => {
      const { onReorder } = renderCustom();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));

      await pickUp(screen.getByRole('button', { name: 'Drag Alpha' }));
      expect(emptySlots()).toBe(2);
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true })); });

      expect(emptySlots()).toBe(0);
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('opens no empty slots in the date sorts', async () => {
      localStorage.setItem('needlewise-gallery-sort:v1', 'created');
      renderGallery([a, b, c], null, arranged);

      await pickUp(screen.getByRole('button', { name: 'Drag Alpha' }));

      expect(emptySlots()).toBe(0);
    });

    it('closes the gap without a reorder when the pattern is dropped into a folder', async () => {
      const gifts = { ...folder('gifts', 'Gifts'), createdAt: 0 };
      const { onReorder, onMoveProjects, rerender } = renderGallery([a, b, c], null, {
        folders: [gifts],
        galleryOrders: [{ levelId: 'root', keys: ['project:a', 'project:b', 'project:c', 'folder:gifts'] }]
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Sort patterns' }), { target: { value: 'custom' } });
      layOutRow(['Alpha', 'Beta', 'Gamma', 'Gifts']);
      let settle = () => {};
      onMoveProjects.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));

      // Beta's middle, the gap before Gamma, Gamma's middle, the gap before Gifts, then Gifts' middle.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']);

      expect(onMoveProjects).toHaveBeenCalledWith([a], 'gifts');
      expect(onReorder).not.toHaveBeenCalled();
      expect(emptySlots()).toBe(0);
      expect(cardNames()).toEqual(['Beta', 'Gamma', 'Gifts']);
      rerender([a, b, c], { folders: [gifts], folderAssignments: [assignment('a', 'gifts')], galleryOrders: [{ levelId: 'root', keys: ['project:a', 'project:b', 'project:c', 'folder:gifts'] }] });
      await act(async () => { settle(); });
      expect(cardNames()).toEqual(['Beta', 'Gamma', 'Gifts']);
    });

    it('cancels the drag when the level changes underneath it', async () => {
      const { onReorder, rerender } = renderCustom();

      await pickUp(screen.getByRole('button', { name: 'Drag Alpha' }));
      expect(emptySlots()).toBe(1);
      rerender([a, b, c, dated('d', 'Delta', 4, 4)]);

      expect(emptySlots()).toBe(0);
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })); });
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('reorders through the gap beside a card and saves the order', async () => {
      const { onReorder, onGroupProjects } = renderCustom();

      // From Gamma's slot, ArrowLeft stops at Beta's middle, the gap before Beta, Alpha's middle, then the gap before Alpha.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Gamma' }), ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);

      expect(onReorder).toHaveBeenCalledWith('root', ['project:c', 'project:a', 'project:b']);
      expect(onGroupProjects).not.toHaveBeenCalled();
    });

    it('saves the order of the current folder', async () => {
      const gifts = folder('gifts', 'Gifts');
      const { onReorder, onGroupProjects } = renderCustom({
        folders: [gifts],
        currentFolderId: 'gifts',
        folderAssignments: ['a', 'b', 'c'].map((id) => assignment(id, 'gifts')),
        galleryOrders: [{ levelId: 'gifts', keys: ['project:a', 'project:b', 'project:c'] }]
      });

      // Over Beta's middle and back to Alpha's own empty slot changes nothing.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), ['ArrowRight', 'ArrowLeft']);
      expect(onReorder).not.toHaveBeenCalled();
      expect(onGroupProjects).not.toHaveBeenCalled();
      // Beta's middle, the gap before Gamma, Gamma's middle, then the gap after Gamma.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']);

      expect(onReorder).toHaveBeenCalledWith('gifts', ['project:b', 'project:c', 'project:a']);
    });

    it('moves a selection as a block in display order', async () => {
      const { onReorder } = renderCustom();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));

      // Alpha and Beta are both carried: Gamma's middle, then the gap after Gamma.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), ['ArrowRight', 'ArrowRight']);

      expect(onReorder).toHaveBeenCalledWith('root', ['project:c', 'project:a', 'project:b']);
    });

    it('does not save an order when a pattern is dropped back in its own slot', async () => {
      const { onReorder, onGroupProjects } = renderCustom();

      await keyboardDrag(screen.getByRole('button', { name: 'Drag Beta' }), ['ArrowLeft', 'ArrowRight']);

      expect(onReorder).not.toHaveBeenCalled();
      expect(onGroupProjects).not.toHaveBeenCalled();
    });

    it('does not save an order when a selection is dropped back in its own slots', async () => {
      const { onReorder, onGroupProjects } = renderCustom();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));

      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), ['ArrowRight', 'ArrowLeft']);

      expect(onReorder).not.toHaveBeenCalled();
      expect(onGroupProjects).not.toHaveBeenCalled();
    });

    it('still creates a folder when a pattern is dropped on the middle of another', async () => {
      const { onReorder, onGroupProjects } = renderCustom();

      await keyboardDrag(screen.getByRole('button', { name: 'Drag Gamma' }), 'ArrowLeft');

      expect(onGroupProjects).toHaveBeenCalledWith([c], b, null);
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('keeps the gap where it was while over a middle, and drops into it from there', async () => {
      const { onReorder, onGroupProjects } = renderCustom();

      // The gap before Beta, then Alpha's middle: the gap stays before Beta, and the drop groups with Alpha.
      await keyboardDrag(screen.getByRole('button', { name: 'Drag Gamma' }), ['ArrowLeft', 'ArrowLeft', 'ArrowLeft']);

      expect(onGroupProjects).toHaveBeenCalledWith([c], a, null);
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('groups on the whole card in the date sorts', async () => {
      localStorage.setItem('needlewise-gallery-sort:v1', 'created');
      const { onReorder, onGroupProjects } = renderGallery([a, b, c], null, arranged);
      layOutRow(['Gamma', 'Beta', 'Alpha']);

      await keyboardDrag(screen.getByRole('button', { name: 'Drag Alpha' }), 'ArrowLeft');

      expect(onGroupProjects).toHaveBeenCalledWith([a], b, null);
      expect(onReorder).not.toHaveBeenCalled();
    });
  });
});

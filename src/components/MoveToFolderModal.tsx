import { compareFolders, type ProjectFolder } from '../persistence';
import { Modal } from './Modal';

interface MoveToFolderModalProps {
  folders: readonly ProjectFolder[];
  currentFolderId: string | null;
  onSelect(folderId: string | null): void;
  onClose(): void;
}

/** The non-drag way to file the selection: the top level, then every folder with its subfolders indented beneath it. */
export function MoveToFolderModal({ folders, currentFolderId, onSelect, onClose }: MoveToFolderModalProps) {
  const sorted = [...folders].sort(compareFolders);
  const destination = (folder: ProjectFolder) => (
    <button className="project-gallery-move-destination" type="button" disabled={folder.id === currentFolderId} onClick={() => onSelect(folder.id)}>
      {folder.name}
    </button>
  );

  return (
    <Modal className="folder-modal" closeLabel="Close move to folder dialog" title="Move to folder" onClose={onClose}>
      <ul className="project-gallery-move-list">
        <li>
          <button className="project-gallery-move-destination" type="button" disabled={currentFolderId === null} onClick={() => onSelect(null)}>
            Projects
          </button>
        </li>
        {sorted.filter((folder) => folder.parentId === null).map((folder) => {
          const children = sorted.filter((child) => child.parentId === folder.id);
          return (
            <li key={folder.id}>
              {destination(folder)}
              {children.length > 0 && (
                <ul className="project-gallery-move-list project-gallery-move-children">
                  {children.map((child) => <li key={child.id}>{destination(child)}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

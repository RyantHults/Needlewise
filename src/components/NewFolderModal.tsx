import { useRef, useState } from 'react';
import { MAX_FOLDER_NAME_CHARS } from '../persistence';
import { Modal } from './Modal';

interface NewFolderModalProps {
  parentName: string | null;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function NewFolderModal({ parentName, busy = false, onSubmit, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Modal
      className="folder-modal"
      closeLabel="Close new folder dialog"
      closeDisabled={busy}
      eyebrow="New folder"
      title={parentName ? `New folder in ${parentName}` : 'Name your folder'}
      titleId="new-folder-title"
      initialFocus={inputRef}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label htmlFor="new-folder-name">Folder name
          <input
            ref={inputRef}
            id="new-folder-name"
            value={name}
            maxLength={MAX_FOLDER_NAME_CHARS}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button className="button button-primary" type="submit" disabled={busy || name.trim().length === 0}>Create folder</button>
      </form>
    </Modal>
  );
}

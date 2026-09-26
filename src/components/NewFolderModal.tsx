import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_FOLDER_NAME_CHARS } from '../persistence';

interface NewFolderModalProps {
  parentName: string | null;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function NewFolderModal({ parentName, busy = false, onSubmit, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mirrors Phase3Panel's portal: inert the rest of the app, trap focus, and
  // restore it to whatever was focused before this modal opened, whichever
  // way it closes (Esc, backdrop click, the × button, or a parent unmounting
  // it after a successful submit).
  useEffect(() => {
    const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.querySelector<HTMLElement>('[data-application]');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    inputRef.current?.focus();
    const el = dialogRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !el) return;
      const focusable = [...el.querySelectorAll<HTMLElement>('button,input')].filter((item) => !item.hasAttribute('disabled') && item.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    el?.addEventListener('keydown', handleKeyDown);
    return () => {
      el?.removeEventListener('keydown', handleKeyDown);
      if (root) root.inert = wasInert;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="create-modal folder-modal" role="dialog" aria-modal="true" aria-labelledby="new-folder-title">
        <button className="modal-close" type="button" aria-label="Close new folder dialog" disabled={busy} onClick={onClose}>×</button>
        <p className="section-label">New folder</p>
        <h2 id="new-folder-title">{parentName ? `New folder in ${parentName}` : 'Name your folder'}</h2>
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
      </div>
    </div>,
    document.body
  );
}

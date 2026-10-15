import { useState } from 'react';

type Props = {
  id: string;
  accept: string;
  /** Accessible name of the hidden file input. */
  inputLabel: string;
  title: string;
  hint: string;
  /** The chosen file, shown in place of the title and hint. */
  file?: File | null;
  selectedHint?: string;
  browseLabel?: string;
  replaceLabel?: string;
  disabled?: boolean;
  onFile: (file: File) => void;
};

/** A labelled upload box: click to browse, or drop a file onto it. */
export function FileDropZone({ id, accept, inputLabel, title, hint, file, selectedHint, browseLabel = 'Browse files', replaceLabel = browseLabel, disabled = false, onFile }: Props) {
  const [dragging, setDragging] = useState(false);
  const handleDragOver = (event: React.DragEvent<HTMLLabelElement>) => {
    // preventDefault marks the zone as a valid drop target; without it the
    // browser opens the dropped file instead of firing drop.
    event.preventDefault();
    if (disabled) { event.dataTransfer.dropEffect = 'none'; return; }
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  return (
    <label
      className={`file-drop${file ? ' file-drop-selected' : ''}${dragging ? ' file-drop-active' : ''}`}
      htmlFor={id}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={e => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); const dropped = e.dataTransfer.files.item(0); if (dropped && !disabled) onFile(dropped); }}
    >
      <svg className="file-drop-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
      {file
        ? <span className="file-drop-text"><strong>{file.name}</strong>{selectedHint && <span className="file-drop-hint">{selectedHint}</span>}</span>
        : <span className="file-drop-text"><span className="file-drop-title">{title}</span><span className="file-drop-hint">{hint}</span></span>}
      <span className="file-drop-button">{file ? replaceLabel : browseLabel}</span>
      {/* Cleared after each choice so choosing the same file again still fires change. */}
      <input id={id} className="visually-hidden" type="file" accept={accept} aria-label={inputLabel} disabled={disabled} onChange={e => { const chosen = e.target.files?.[0]; e.target.value = ''; if (chosen) onFile(chosen); }} />
    </label>
  );
}

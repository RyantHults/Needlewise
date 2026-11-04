interface GallerySelectionBarProps {
  count: number;
  disabled: boolean;
  onSelectAll(): void;
  onMove(): void;
  onDuplicate(): void;
  onDelete(): void;
  onClear(): void;
}

/** The bulk actions over the patterns ticked in the gallery. */
export function GallerySelectionBar({ count, disabled, onSelectAll, onMove, onDuplicate, onDelete, onClear }: GallerySelectionBarProps) {
  return (
    <div className="project-gallery-selection-bar" role="toolbar" aria-label="Selected patterns">
      <span className="project-gallery-selection-count">{count} selected</span>
      <div className="project-gallery-selection-actions">
        <button className="button button-secondary" type="button" disabled={disabled} onClick={onSelectAll}>Select all</button>
        <button className="button button-secondary" type="button" disabled={disabled} onClick={onMove}>Move to folder…</button>
        <button className="button button-secondary" type="button" disabled={disabled} onClick={onDuplicate}>Duplicate</button>
        <button className="button button-secondary project-gallery-selection-delete" type="button" disabled={disabled} onClick={onDelete}>Delete</button>
        <button className="project-gallery-selection-clear" type="button" aria-label="Clear selection" onClick={onClear}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}

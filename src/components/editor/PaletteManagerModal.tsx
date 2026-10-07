import { useEffect, useRef } from "react";
import type { PaletteEntry } from "../../domain";
import { Modal, type ModalProps } from "../Modal";
import { ThreadColorPicker, type ThreadColorPickerProps } from "../ThreadColorPicker";

export type PaletteManagerPanel = "swap" | "add" | null;

export interface PaletteManagerModalProps {
  palette: readonly PaletteEntry[];
  /** The chip's color: the caller falls back to the first color when its pick is gone. */
  selected: PaletteEntry | null;
  panel: PaletteManagerPanel;
  /** The catalog code (with brand when ambiguous), or the hex for a custom color. */
  entryLabel: (entry: PaletteEntry) => string;
  /** Drawn inside each grid swatch, e.g. the color's symbol. */
  swatchContent?: (entry: PaletteEntry) => React.ReactNode;
  picker: ThreadColorPickerProps;
  notice?: string;
  onSelect: (id: number) => void;
  onToggleSwap: () => void;
  onToggleAdd: () => void;
  onClosePanel: () => void;
  onDelete: (id: number, trigger: HTMLButtonElement) => void;
  onClose: () => void;
  returnFocus?: ModalProps["returnFocus"];
}

/**
 * Every active palette color in one grid, with the selected one in a chip that
 * swaps or deletes it. Swap and the add tile open the thread color picker in a
 * panel beside the grid, so the palette stays in view while picking.
 */
export function PaletteManagerModal({
  palette,
  selected,
  panel,
  entryLabel,
  swatchContent,
  picker,
  notice,
  onSelect,
  onToggleSwap,
  onToggleAdd,
  onClosePanel,
  onDelete,
  onClose,
  returnFocus,
}: PaletteManagerModalProps) {
  const swapButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef(panel);
  // Closing the panel by any route (toggle, Escape, a finished swap or add)
  // returns focus to the control that opened it.
  useEffect(() => {
    const closed = previousPanel.current;
    previousPanel.current = panel;
    if (panel !== null || closed === null) return;
    (closed === "swap" ? swapButton : addButton).current?.focus();
  }, [panel]);
  return (
    <Modal
      className={`catalog-dialog palette-manager-dialog${panel ? " palette-manager-panel-open" : ""}`}
      closeLabel="Close palette manager"
      eyebrow="Color palette"
      title="Manage"
      titleId="palette-manager-title"
      initialFocus='.palette-manager-grid [aria-pressed="true"]'
      returnFocus={returnFocus}
      onClose={onClose}
      onEscape={panel ? onClosePanel : onClose}
    >
      <div className="palette-manager-columns">
        <section className="palette-manager-palette">
          <div className="catalog-box">
            <div className="catalog-selection" aria-label="Selected palette color" role="group">
              {selected ? (
                <>
                  <span className="catalog-selection-swatch swatch" style={{ background: selected.color }} aria-hidden="true" />
                  <span className="catalog-selection-details">
                    <strong>{selected.name}</strong>
                    <span>{entryLabel(selected)}</span>
                  </span>
                  <div className="palette-manager-actions">
                    <button ref={swapButton} className="small-action" type="button" aria-label={`Swap ${selected.name}`} aria-expanded={panel === "swap"} aria-controls="palette-manager-panel" onClick={onToggleSwap}>Swap</button>
                    <button className="small-action palette-manager-delete" type="button" aria-label={`Delete ${selected.name}`} onClick={(e) => onDelete(selected.id, e.currentTarget)}>Delete</button>
                  </div>
                </>
              ) : (
                <span className="catalog-selection-empty">No colors in this palette yet.</span>
              )}
            </div>
            <div className="catalog-color-grid palette-manager-grid" role="list" aria-label="Palette colors">
              <div role="listitem">
                <button ref={addButton} className="catalog-color-button palette-manager-add" type="button" aria-label="Add color" title="Add color" aria-expanded={panel === "add"} aria-controls="palette-manager-panel" onClick={onToggleAdd}><span className="palette-manager-add-glyph" aria-hidden="true">+</span></button>
              </div>
              {palette.map((entry) => (
                <div role="listitem" key={entry.id}>
                  <button
                    className="catalog-color-button"
                    type="button"
                    aria-label={`${entry.name}, ${entryLabel(entry)}`}
                    aria-pressed={selected?.id === entry.id}
                    onClick={() => onSelect(entry.id)}
                  >
                    <span className="catalog-color-swatch" style={{ background: entry.color }} aria-hidden="true">
                      {swatchContent?.(entry)}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
        {(panel === "add" || (panel === "swap" && selected)) && (
          <section id="palette-manager-panel" className="palette-manager-panel" aria-label={panel === "swap" && selected ? `Swap ${selected.name} for a thread color` : "Add a thread color"}>
            {/* Remounted per mode, so switching between swap and add starts a fresh pick. */}
            <ThreadColorPicker key={panel} {...picker} />
            {notice && (
              <p className="modal-error" role="alert">
                {notice}
              </p>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}

import { useRef } from "react";
import { Modal, type ModalProps } from "./Modal";
import { ThreadColorPicker, type ThreadColorPickerProps } from "./ThreadColorPicker";

export interface ColorPickerModalProps extends ThreadColorPickerProps {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** Rendered as an alert below the picker. */
  notice?: string;
  onClose: () => void;
  returnFocus?: ModalProps["returnFocus"];
}

/** The thread color picker in its catalog dialog, for adding, swapping or choosing a color. */
export function ColorPickerModal({ eyebrow, title, hint, notice, onClose, returnFocus, ...picker }: ColorPickerModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  // Search when the catalog is usable, otherwise the selected tab, otherwise the ×.
  const initialFocus = {
    get current() {
      const el = dialog.current;
      const search = el?.querySelector<HTMLInputElement>("#catalog-search");
      if (search && !search.disabled) return search;
      return el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? el?.querySelector<HTMLElement>(".modal-close") ?? null;
    },
  };
  return (
    <Modal
      className="catalog-dialog"
      closeLabel="Close catalog dialog"
      titleId="editor-catalog-title"
      eyebrow={eyebrow}
      title={title}
      onClose={onClose}
      returnFocus={returnFocus}
      initialFocus={initialFocus}
      dialogRef={dialog}
    >
      {hint && <p className="modal-hint">{hint}</p>}
      <ThreadColorPicker {...picker} />
      {notice && (
        <p className="modal-error" role="alert">
          {notice}
        </p>
      )}
    </Modal>
  );
}

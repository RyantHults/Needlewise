import { useRef } from "react";
import { Modal, type ModalProps } from "./Modal";
import { ThreadColorPicker, type ThreadColorPickerProps } from "./ThreadColorPicker";
import { ErrorNotice } from "./controls/Notice";

export interface CatalogPickerDialogProps {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** Rendered as an alert below the picker. */
  notice?: string;
  onClose: () => void;
  returnFocus?: ModalProps["returnFocus"];
  /** The picker: a thread or a bead picker. */
  children: React.ReactNode;
}

export type ColorPickerModalProps = Omit<CatalogPickerDialogProps, "children"> & ThreadColorPickerProps;

/** The thread color picker in its catalog dialog, for adding, swapping or choosing a color. */
export function ColorPickerModal({ eyebrow, title, hint, notice, onClose, returnFocus, ...picker }: ColorPickerModalProps) {
  return (
    <CatalogPickerDialog eyebrow={eyebrow} title={title} hint={hint} notice={notice} onClose={onClose} returnFocus={returnFocus}>
      <ThreadColorPicker {...picker} />
    </CatalogPickerDialog>
  );
}

/** The catalog dialog around a color picker. */
export function CatalogPickerDialog({ eyebrow, title, hint, notice, onClose, returnFocus, children }: CatalogPickerDialogProps) {
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
      {children}
      {notice && <ErrorNotice>{notice}</ErrorNotice>}
    </Modal>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_LAYER_NAME_CHARS } from "../../domain";

interface Props {
  name: string;
  /** Called with the trimmed name; only when it is non-empty and different. */
  onSave: (name: string) => void;
  onClose: () => void;
}

/** A small modal for renaming a layer: Enter saves, Escape cancels. */
export function RenameLayerDialog({ name, onSave, onClose }: Props) {
  const [value, setValue] = useState(name);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    const root = globalThis.document.querySelector<HTMLElement>("[data-application]");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    input.current?.focus();
    input.current?.select();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>("button,input")].filter((item) => !item.hasAttribute("disabled"));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    element.addEventListener("keydown", key);
    return () => { element.removeEventListener("keydown", key); if (root) root.inert = wasInert; };
  }, [onClose]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    if (trimmed !== name) onSave(trimmed);
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} className="catalog-dialog create-modal rename-layer-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-layer-title">
        <p className="section-label">Layers</p>
        <h2 id="rename-layer-title">Rename layer</h2>
        <form onSubmit={submit}>
          <label className="rename-layer-field" htmlFor="rename-layer-input">
            Name
            <input
              ref={input}
              id="rename-layer-input"
              type="text"
              value={value}
              maxLength={MAX_LAYER_NAME_CHARS}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div className="actions">
            <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={!trimmed}>Save</button>
          </div>
        </form>
      </div>
    </div>,
    globalThis.document.body,
  );
}

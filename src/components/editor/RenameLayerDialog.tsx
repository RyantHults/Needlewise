import { useEffect, useRef, useState } from "react";
import { MAX_LAYER_NAME_CHARS } from "../../domain";
import { Modal } from "../Modal";

interface Props {
  name: string;
  /** Called with the trimmed name; only when it is non-empty and different. */
  onSave: (name: string) => void;
  onClose: () => void;
}

/** A small modal for renaming a layer: Enter saves, Escape cancels. */
export function RenameLayerDialog({ name, onSave, onClose }: Props) {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();

  useEffect(() => { input.current?.select(); }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    if (trimmed !== name) onSave(trimmed);
    onClose();
  };

  return (
    <Modal eyebrow="Layers" title="Rename layer" titleId="rename-layer-title" className="catalog-dialog rename-layer-dialog" initialFocus={input} onClose={onClose}>
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
    </Modal>
  );
}

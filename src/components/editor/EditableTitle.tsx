import { useEffect, useId, useRef, useState } from "react";

interface Props {
  value: string;
  onCommit: (title: string) => void;
  headingId: string;
  className?: string;
}

export function EditableTitle({ value, onCommit, headingId, className }: Props) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function start() {
    settledRef.current = false;
    setDraft(value);
    setEditing(true);
  }

  function commit() {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== value) onCommit(trimmed);
  }

  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    setDraft(value);
    setEditing(false);
  }

  return (
    <h2 id={headingId} className={className ? `editable-title ${className}` : "editable-title"}>
      {editing ? (
        <>
          <label className="visually-hidden" htmlFor={inputId}>Rename pattern {value}</label>
          <input
            ref={inputRef}
            id={inputId}
            className="editable-title-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commit(); }
              else if (event.key === "Escape") { event.preventDefault(); cancel(); }
            }}
          />
        </>
      ) : (
        <button className="editable-title-button" type="button" aria-label={`Rename ${value}`} onClick={start}>
          {value}
        </button>
      )}
    </h2>
  );
}

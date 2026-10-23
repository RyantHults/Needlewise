import { useId } from "react";
import { useInlineEdit } from "../inline-edit";

interface Props {
  value: string;
  onCommit: (title: string) => void;
  headingId: string;
  className?: string;
}

export function EditableTitle({ value, onCommit, headingId, className }: Props) {
  const inputId = useId();
  const { editing, start, triggerRef, inputProps } = useInlineEdit(value, onCommit);

  return (
    <h2 id={headingId} className={className ? `editable-title ${className}` : "editable-title"}>
      {editing ? (
        <>
          <label className="visually-hidden" htmlFor={inputId}>Rename pattern {value}</label>
          <input
            id={inputId}
            className="editable-title-input"
            {...inputProps}
          />
        </>
      ) : (
        <button ref={triggerRef} className="editable-title-button" type="button" aria-label={`Rename ${value}`} onClick={start}>
          {value}
        </button>
      )}
    </h2>
  );
}

import { type ReactNode } from 'react';

interface NumberFieldProps {
  id: string;
  label: string;
  value: string;
  inputMode: 'numeric' | 'decimal';
  min: string;
  error: string | undefined;
  onChange: (value: string) => void;
}

/** A whole-number-or-more draft input with its inline error. */
export function NumberField({ id, label, value, inputMode, min, error, onChange }: NumberFieldProps) {
  return (
    <div className="export-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode={inputMode} min={min} step="1" value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} />
      {error && <p className="export-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

interface SelectFieldProps {
  id: string;
  label: string;
  value: string | number;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}

export function SelectField({ id, label, value, disabled, onChange, children }: SelectFieldProps) {
  return (
    <div className="export-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </div>
  );
}

interface SwitchProps {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({ id, label, checked, disabled, onChange }: SwitchProps) {
  return (
    <div className="export-field">
      <span id={`${id}-label`} className="export-label">{label}</span>
      <button id={id} type="button" role="switch" className="export-toggle" aria-checked={checked} aria-labelledby={`${id}-label`} disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="export-toggle-track" aria-hidden="true"><span className="export-toggle-thumb" /></span>
        <span className="export-toggle-text">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

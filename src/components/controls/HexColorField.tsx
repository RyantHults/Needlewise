import { useEffect, useState } from 'react';
import { normalizeHexColor } from '../../domain/color';

interface HexColorFieldProps {
  /** Id of the text input; the native picker gets `{id}-picker`, the help text `{id}-help`. */
  id: string;
  /** The committed `#RRGGBB`, or '' for none. A change here replaces the draft. */
  value: string;
  /** The canonical `#RRGGBB` when the draft parses, undefined while it does not. */
  onChange: (color: string | undefined) => void;
  pickerLabel: string;
  textLabel: string;
  placeholder: string;
  /** Shown below the fields; `invalidHelp` replaces it while the draft does not parse. */
  help?: string;
  invalidHelp?: string;
  /** Layout modifier merged onto the `custom-color-fields` wrapper. */
  className?: string;
}

/** A native color picker and a hex text input over one color. The text stays as typed while editing and becomes uppercase `#RRGGBB` on blur when it parses. */
export function HexColorField({ id, value, onChange, pickerLabel, textLabel, placeholder, help, invalidHelp, className }: HexColorFieldProps) {
  const [draft, setDraft] = useState(value);
  const [picked, setPicked] = useState(() => normalizeHexColor(value) ?? '#000000');

  useEffect(() => {
    const canonical = normalizeHexColor(value);
    if (canonical === undefined) return;
    setPicked(canonical);
    setDraft((current) => (normalizeHexColor(current) === canonical ? current : canonical));
  }, [value]);

  const change = (text: string) => {
    const canonical = normalizeHexColor(text);
    setDraft(text);
    if (canonical !== undefined) setPicked(canonical);
    onChange(canonical);
  };
  const settle = () => {
    const canonical = normalizeHexColor(draft);
    if (canonical !== undefined) setDraft(canonical);
  };
  const invalid = draft !== '' && normalizeHexColor(draft) === undefined;
  const message = invalid ? invalidHelp ?? help : help;

  return (
    <>
      <div className={['custom-color-fields', className ?? ''].filter(Boolean).join(' ')}>
        <label htmlFor={`${id}-picker`}>{pickerLabel}</label>
        <input id={`${id}-picker`} className="custom-color-picker" type="color" value={picked.toLowerCase()} onChange={(event) => change(normalizeHexColor(event.target.value) ?? event.target.value)} />
        <label htmlFor={id}>{textLabel}</label>
        <input id={id} type="text" value={draft} maxLength={7} placeholder={placeholder} autoComplete="off" aria-describedby={message ? `${id}-help` : undefined} onChange={(event) => change(event.target.value)} onBlur={settle} />
      </div>
      {message && <p id={`${id}-help`} className="custom-color-help" aria-live="polite">{message}</p>}
    </>
  );
}

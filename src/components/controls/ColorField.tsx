import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeHexColor, rgbToHex } from '../../domain/color';
import { anchoredPosition, type AnchoredPosition } from '../anchored-position';
import { useDismissable } from '../dismiss';
import { ColorPicker, useHexDraft } from './ColorPicker';

interface ColorFieldProps {
  /** Id of the text input; the swatch button gets `{id}-picker`, the help text `{id}-help`. */
  id: string;
  /** The committed `#RRGGBB`, or '' for none. A change here replaces the draft. */
  value: string;
  /** The canonical `#RRGGBB` when the draft parses, undefined while it does not. */
  onChange: (color: string | undefined) => void;
  /** Names the swatch button and the picker it opens. */
  pickerLabel: string;
  textLabel: string;
  /** The text input's placeholder, and the picker's starting colour while `value` is empty. */
  placeholder: string;
  /** Shown below the fields; `invalidHelp` replaces it while the draft does not parse. */
  help?: string;
  invalidHelp?: string;
  /** Layout modifier merged onto the `custom-color-fields` wrapper. */
  className?: string;
}

/**
 * A swatch button and a hex text input over one color. The text stays as typed while editing and
 * becomes uppercase `#RRGGBB` on blur when it parses. The swatch opens the color picker in a
 * popover anchored below it, which every change of the picker writes through at once.
 */
export function ColorField({ id, value, onChange, pickerLabel, textLabel, placeholder, help, invalidHelp, className }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<AnchoredPosition>({ left: 0, top: 0 });
  const swatch = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const hex = useHexDraft(value, onChange);
  // A caller that clears `value` while the draft is invalid still shows, and picks from, the last valid color.
  const valid = normalizeHexColor(value);
  const [shown, setShown] = useState(valid);
  if (valid !== undefined && valid !== shown) setShown(valid);
  const message = hex.invalid ? invalidHelp ?? help : help;
  useDismissable({ open, refs: [popover, swatch], onDismiss: () => setOpen(false), returnFocus: swatch });

  // Placed once it has rendered, so the flip above the swatch knows the popover's real height.
  useLayoutEffect(() => {
    const rect = swatch.current?.getBoundingClientRect();
    const size = popover.current?.getBoundingClientRect();
    if (open && rect && size) setPosition(anchoredPosition(rect, 'below', { width: size.width, height: size.height }));
  }, [open]);

  return (
    <>
      <div className={['custom-color-fields', className ?? ''].filter(Boolean).join(' ')}>
        <label htmlFor={`${id}-picker`}>{pickerLabel}</label>
        <button
          ref={swatch}
          id={`${id}-picker`}
          type="button"
          className="color-swatch-button"
          style={shown ? { background: shown } : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
        <label htmlFor={id}>{textLabel}</label>
        <input id={id} type="text" value={hex.draft} maxLength={7} placeholder={placeholder} autoComplete="off" aria-describedby={message ? `${id}-help` : undefined} onChange={hex.onChange} onBlur={hex.onBlur} />
      </div>
      {message && <p id={`${id}-help`} className="custom-color-help" aria-live="polite">{message}</p>}
      {open && createPortal(
        <div ref={popover} className="popover-menu color-picker-popover" role="dialog" aria-label={pickerLabel} style={{ position: 'fixed', ...position, zIndex: 1000 }}>
          <ColorPicker value={shown ?? normalizeHexColor(placeholder) ?? rgbToHex(0, 0, 0).toUpperCase()} onChange={onChange} invalidHelp={invalidHelp} />
        </div>,
        globalThis.document.body
      )}
    </>
  );
}

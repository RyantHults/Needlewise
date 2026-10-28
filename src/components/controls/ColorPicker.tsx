import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { hslToRgb, hsvToRgb, normalizeHexColor, parseHexColor, rgbToHex, rgbToHsl, rgbToHsv, type Hsv, type Rgb } from '../../domain/color';
import { SegmentedControl } from './SegmentedControl';

/**
 * The colour picker body: a saturation × brightness area, a hue bar, an
 * old/new comparison, a hex field, the screen eyedropper where the browser has
 * one, and RGB or HSL number fields. It is controlled through `value` and
 * `onChange`, but keeps its own HSV state, so the hue survives a pass through
 * grey and the saturation survives black. Every change emits a canonical
 * `#RRGGBB`, continuously while dragging.
 */

interface ColorPickerProps {
  /** The colour shown, as `#RRGGBB`. The value when the picker mounts is the "old" colour. */
  value: string;
  onChange: (color: string) => void;
  /** Shown under the hex field while its draft does not parse. */
  invalidHelp?: string;
}

type ColorModel = 'rgb' | 'hsl';

const MODEL_OPTIONS = [
  { value: 'rgb', label: 'RGB' },
  { value: 'hsl', label: 'HSL' }
] as const;

// The chosen model lasts for the session, across every picker.
let sessionModel: ColorModel = 'rgb';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const css = (rgb: Rgb) => rgbToHex(...rgb);
const hexOf = (hsv: Hsv) => css(hsvToRgb(hsv)).toUpperCase();
const percent = (fraction: number) => Math.round(fraction * 100);

/** The HSV of `rgb`, keeping `previous`'s hue where `rgb` is grey and its saturation too where it is black. */
function hsvFromRgb(rgb: Rgb, previous: Hsv): Hsv {
  const [hue, saturation, value] = rgbToHsv(rgb);
  if (value === 0) return [previous[0], previous[1], 0];
  if (saturation === 0) return [previous[0], 0, value];
  return [hue, saturation, value];
}

const hsvFromHex = (hex: string, previous: Hsv): Hsv => {
  const rgb = parseHexColor(hex);
  return rgb ? hsvFromRgb(rgb, previous) : previous;
};

/**
 * The draft of a hex text field over a canonical `value`: it stays as typed
 * while it is edited, becomes `#RRGGBB` on blur when it parses, and is replaced
 * when `value` changes to a colour the draft does not already spell.
 */
export function useHexDraft(value: string, onChange: (color: string | undefined) => void) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const canonical = normalizeHexColor(value);
    if (canonical !== undefined && normalizeHexColor(draft) !== canonical) setDraft(canonical);
  }
  return {
    draft,
    invalid: draft !== '' && normalizeHexColor(draft) === undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      onChange(normalizeHexColor(event.target.value));
    },
    onBlur: () => {
      const canonical = normalizeHexColor(draft);
      if (canonical !== undefined) setDraft(canonical);
    }
  };
}

/** Pointer handlers for a drag surface: a press jumps to the point and captures the pointer until release. */
function useDrag(update: (x: number, y: number, rect: DOMRect) => void) {
  const dragging = useRef(false);
  const at = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) update(event.clientX, event.clientY, rect);
  };
  const stop = () => { dragging.current = false; };
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragging.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.focus();
      at(event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => { if (dragging.current) at(event); },
    onPointerUp: stop,
    onPointerCancel: stop
  };
}

interface ChannelFieldProps {
  label: string;
  value: number;
  max: number;
  onCommit: (value: number) => void;
}

/** A whole-number field from 0 to `max`. A valid edit applies at once; anything else waits for blur and snaps back. */
function ChannelField({ label, value, max, onCommit }: ChannelFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(String(value));
  }
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        min={0}
        max={max}
        step={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== '' && Number.isInteger(next) && next >= 0 && next <= max) onCommit(next);
        }}
        onBlur={() => setDraft(String(value))}
      />
    </label>
  );
}

interface EyeDropperInstance {
  open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
}

/** The screen eyedropper, which only Chromium-based browsers have. */
const eyeDropper = (): (new () => EyeDropperInstance) | undefined =>
  (globalThis as unknown as { EyeDropper?: new () => EyeDropperInstance }).EyeDropper;

const HUE_STOPS = [0, 1, 2, 3, 4, 5, 6].map((index) => css(hsvToRgb([index * 60, 1, 1]))).join(', ');

export function ColorPicker({ value, onChange, invalidHelp }: ColorPickerProps) {
  const hexId = useId();
  const [old] = useState(value);
  const [hsv, setHsv] = useState<Hsv>(() => hsvFromHex(value, [0, 0, 0]));
  const [seen, setSeen] = useState(value);
  const [model, setModel] = useState<ColorModel>(sessionModel);
  const area = useRef<HTMLDivElement>(null);
  const picking = useRef<AbortController | null>(null);
  const [screenPicking, setScreenPicking] = useState(false);
  const current = hexOf(hsv);
  // A value from outside resets the state only when it is not the colour the state already makes.
  if (value !== seen) {
    setSeen(value);
    if (normalizeHexColor(value) !== current) setHsv(hsvFromHex(value, hsv));
  }

  useEffect(() => {
    area.current?.focus();
    return () => picking.current?.abort();
  }, []);

  const apply = (next: Hsv) => {
    setHsv(next);
    onChange(hexOf(next));
  };
  const applyHex = (hex: string | undefined) => { if (hex) apply(hsvFromHex(hex, hsv)); };
  const hex = useHexDraft(current, applyHex);

  const [hue, saturation, brightness] = hsv;
  const rgb = hsvToRgb(hsv);
  // HSL is shown from the HSV hue, since a grey's RGB has none.
  const [, hslSaturation, lightness] = rgbToHsl(rgb);

  const areaDrag = useDrag((x, y, rect) => apply([hue, clamp((x - rect.left) / rect.width, 0, 1), 1 - clamp((y - rect.top) / rect.height, 0, 1)]));
  const hueDrag = useDrag((x, _y, rect) => apply([clamp((x - rect.left) / rect.width, 0, 1) * 360, saturation, brightness]));

  const onAreaKey = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, () => Hsv> = {
      ArrowLeft: () => [hue, clamp(saturation - step, 0, 1), brightness],
      ArrowRight: () => [hue, clamp(saturation + step, 0, 1), brightness],
      ArrowDown: () => [hue, saturation, clamp(brightness - step, 0, 1)],
      ArrowUp: () => [hue, saturation, clamp(brightness + step, 0, 1)],
      Home: () => [hue, 0, brightness],
      End: () => [hue, 1, brightness],
      PageDown: () => [hue, saturation, 0],
      PageUp: () => [hue, saturation, 1]
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    apply(move());
  };
  const onHueKey = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 15 : 1;
    const moves: Record<string, number> = {
      ArrowLeft: hue - step,
      ArrowDown: hue - step,
      ArrowRight: hue + step,
      ArrowUp: hue + step,
      PageDown: hue - 15,
      PageUp: hue + 15,
      Home: 0,
      End: 360
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    apply([clamp(moves[event.key], 0, 360), saturation, brightness]);
  };

  const pickFromScreen = async () => {
    const EyeDropper = eyeDropper();
    if (!EyeDropper) return;
    picking.current?.abort();
    const controller = new AbortController();
    picking.current = controller;
    setScreenPicking(true);
    try {
      const result = await new EyeDropper().open({ signal: controller.signal });
      if (!controller.signal.aborted) applyHex(normalizeHexColor(result.sRGBHex));
    } catch {
      // Cancelled by the user, or aborted because the picker closed.
    } finally {
      if (picking.current === controller) setScreenPicking(false);
    }
  };

  const chooseModel = (next: ColorModel) => {
    sessionModel = next;
    setModel(next);
  };

  // The area's gradients are colour data built from the model, not theme: white to the hue across, transparent to black up.
  const black = css(hsvToRgb([hue, 0, 0]));
  const areaStyle: CSSProperties = {
    backgroundImage: `linear-gradient(to top, ${black}, ${black}00), linear-gradient(to right, ${css(hsvToRgb([hue, 0, 1]))}, ${css(hsvToRgb([hue, 1, 1]))})`
  };

  return (
    <div className="color-picker">
      <div
        ref={area}
        className="color-picker-area"
        style={areaStyle}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(saturation)}
        aria-valuetext={`Saturation ${percent(saturation)}%, brightness ${percent(brightness)}%`}
        onKeyDown={onAreaKey}
        {...areaDrag}
      >
        <span className="color-picker-thumb" style={{ left: `${saturation * 100}%`, top: `${(1 - brightness) * 100}%`, background: current }} />
      </div>
      <div
        className="color-picker-hue"
        style={{ backgroundImage: `linear-gradient(to right, ${HUE_STOPS})` }}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hue)}
        aria-valuetext={`Hue ${Math.round(hue)}°`}
        onKeyDown={onHueKey}
        {...hueDrag}
      >
        <span className="color-picker-thumb" style={{ left: `${(hue / 360) * 100}%`, background: css(hsvToRgb([hue, 1, 1])) }} />
      </div>
      <div className="color-picker-row">
        <div className="color-picker-compare">
          <button type="button" style={{ background: old }} aria-label={`Revert to ${old}`} title={`Revert to ${old}`} onClick={() => applyHex(old)} />
          <span style={{ background: current }} aria-hidden="true" />
        </div>
        <label className="visually-hidden" htmlFor={hexId}>Hex value</label>
        <input id={hexId} className="color-picker-hex" type="text" value={hex.draft} maxLength={7} autoComplete="off" spellCheck={false} aria-describedby={hex.invalid ? `${hexId}-help` : undefined} onChange={hex.onChange} onBlur={hex.onBlur} />
        {eyeDropper() && (
          <button type="button" className="color-picker-eyedropper" aria-pressed={screenPicking} aria-label="Pick a colour from the screen" title="Pick a colour from the screen" onClick={() => void pickFromScreen()}>
            <span aria-hidden="true">⌖</span>
          </button>
        )}
      </div>
      {hex.invalid && invalidHelp && <p id={`${hexId}-help`} className="custom-color-help" aria-live="polite">{invalidHelp}</p>}
      <SegmentedControl className="color-picker-model" aria-label="Color model" options={MODEL_OPTIONS} value={model} onChange={chooseModel} />
      <div className="color-picker-channels">
        {model === 'rgb' ? (
          <>
            <ChannelField label="R" value={rgb[0]} max={255} onCommit={(red) => apply(hsvFromRgb([red, rgb[1], rgb[2]], hsv))} />
            <ChannelField label="G" value={rgb[1]} max={255} onCommit={(green) => apply(hsvFromRgb([rgb[0], green, rgb[2]], hsv))} />
            <ChannelField label="B" value={rgb[2]} max={255} onCommit={(blue) => apply(hsvFromRgb([rgb[0], rgb[1], blue], hsv))} />
          </>
        ) : (
          <>
            <ChannelField label="H" value={Math.round(hue)} max={360} onCommit={(nextHue) => apply([nextHue, saturation, brightness])} />
            <ChannelField label="S" value={percent(hslSaturation)} max={100} onCommit={(nextSaturation) => apply(withHue(hslToRgb([hue, nextSaturation / 100, lightness]), hue, hsv))} />
            <ChannelField label="L" value={percent(lightness)} max={100} onCommit={(nextLightness) => apply(withHue(hslToRgb([hue, hslSaturation, nextLightness / 100]), hue, hsv))} />
          </>
        )}
      </div>
    </div>
  );
}

/** The HSV of an HSL edit, with the hue the user is editing in rather than the one a grey's RGB would give. */
function withHue(rgb: Rgb, hue: number, previous: Hsv): Hsv {
  const [, saturation, value] = hsvFromRgb(rgb, previous);
  return [hue, saturation, value];
}

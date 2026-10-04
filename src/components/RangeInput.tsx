import type { ComponentProps, CSSProperties } from 'react';

type Props = Omit<ComponentProps<'input'>, 'type'>;

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * A native range input whose fill is drawn from the controlled value.
 * WebKit on iPadOS paints the native accent-color fill out of sync with the
 * thumb while dragging, so `.range-input` hides it and paints the track from
 * `--range-fill` (a percentage) and `--range-fill-ratio` (the same, unitless).
 */
export function RangeInput({ className, style, ...props }: Props) {
  const min = finiteOr(props.min, 0);
  const max = finiteOr(props.max, 100);
  const value = finiteOr(props.value ?? props.defaultValue, 0);
  const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const fill = { '--range-fill': `${ratio * 100}%`, '--range-fill-ratio': ratio } as CSSProperties;
  return <input {...props} type="range" className={className ? `range-input ${className}` : 'range-input'} style={{ ...style, ...fill }} />;
}

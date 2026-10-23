import { type ReactNode } from 'react';

interface StepperButtonsProps {
  /** What is being stepped, lowercase: "color budget" gives "Decrease color budget". */
  label: string;
  value: number;
  min: number;
  max: number;
  /** Called with the clamped result; never with the current value. */
  onChange: (next: number) => void;
  /** The count display, between the buttons. */
  children?: ReactNode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** A − button and a + button around the caller's count display. Both disable at the bounds. */
export function StepperButtons({ label, value, min, max, onChange, children }: StepperButtonsProps) {
  const step = (delta: number) => {
    const next = clamp(value + delta, min, max);
    if (next !== value) onChange(next);
  };
  return (
    <span className="budget-stepper">
      <button type="button" className="budget-step" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => step(-1)}>−</button>
      {children}
      <button type="button" className="budget-step" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => step(1)}>+</button>
    </span>
  );
}

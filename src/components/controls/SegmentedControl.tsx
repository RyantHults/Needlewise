import { type HTMLAttributes, type ReactNode } from 'react';

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Text buttons of which exactly one is pressed. Name the group with `aria-label` or `aria-labelledby`. */
export function SegmentedControl<T extends string>({ options, value, onChange, className, ...rest }: SegmentedControlProps<T>) {
  const classes = ['segmented-control', className ?? ''].filter(Boolean).join(' ');
  return (
    <div {...rest} role="group" className={classes}>
      {options.map((option) => (
        <button key={option.value} type="button" className="segmented-option" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

import { type SelectHTMLAttributes } from 'react';
import { FABRIC_COUNTS } from '../../domain';

interface FabricCountSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: number;
  onChange: (count: number) => void;
}

/** The common fabric counts, plus the current one when it is not among them. Name it with a `<label>`. */
export function FabricCountSelect({ value, onChange, ...rest }: FabricCountSelectProps) {
  const counts = FABRIC_COUNTS.includes(value) ? FABRIC_COUNTS : [...FABRIC_COUNTS, value].sort((a, b) => a - b);
  return (
    <select {...rest} value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
      {counts.map((count) => <option key={count} value={String(count)}>{count}</option>)}
    </select>
  );
}

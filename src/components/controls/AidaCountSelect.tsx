import { type SelectHTMLAttributes } from 'react';
import { COMMON_AIDA_COUNTS } from '../../domain';

interface AidaCountSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: number;
  onChange: (count: number) => void;
}

/** The common fabric counts, plus the current one when it is not among them. Name it with a `<label>`. */
export function AidaCountSelect({ value, onChange, ...rest }: AidaCountSelectProps) {
  const counts = COMMON_AIDA_COUNTS.includes(value) ? COMMON_AIDA_COUNTS : [...COMMON_AIDA_COUNTS, value].sort((a, b) => a - b);
  return (
    <select {...rest} value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
      {counts.map((count) => <option key={count} value={String(count)}>{count}</option>)}
    </select>
  );
}

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { COMMON_AIDA_COUNTS } from '../../domain';
import { AidaCountSelect } from './AidaCountSelect';
import { HexColorField } from './HexColorField';

describe('AidaCountSelect', () => {
  const optionValues = () => screen.getAllByRole('option').map((option) => option.textContent);

  it('offers the common counts and reports a number', () => {
    const onChange = vi.fn();
    render(<AidaCountSelect aria-label="Aida" value={14} onChange={onChange} />);

    expect(optionValues()).toEqual(COMMON_AIDA_COUNTS.map(String));
    expect(screen.getByRole('combobox', { name: 'Aida' })).toHaveValue('14');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '18' } });
    expect(onChange).toHaveBeenCalledWith(18);
  });

  it('adds an uncommon current count in sorted position', () => {
    render(<AidaCountSelect aria-label="Aida" value={15} onChange={() => {}} />);

    expect(optionValues()).toEqual(['11', '14', '15', '16', '18', '20', '22', '25', '28', '32']);
    expect(screen.getByRole('combobox')).toHaveValue('15');
  });
});

describe('HexColorField', () => {
  function Harness({ initial = '', onColor }: { initial?: string; onColor?: (color: string | undefined) => void }) {
    const [color, setColor] = useState(initial);
    return <HexColorField id="hex" value={color} onChange={(next) => { onColor?.(next); if (next) setColor(next); }} pickerLabel="Pick" textLabel="Hex" placeholder="#C72B3B" help="Use a hex value." invalidHelp="Enter a valid hex." />;
  }

  it('normalizes a valid draft and reports it', () => {
    const onColor = vi.fn();
    render(<Harness onColor={onColor} />);
    const text = screen.getByLabelText('Hex');

    fireEvent.change(text, { target: { value: 'c72' } });
    expect(onColor).toHaveBeenLastCalledWith('#CC7722');
    expect(text).toHaveValue('#CC7722');
    expect(screen.getByLabelText('Pick')).toHaveValue('#cc7722');
    expect(text).toHaveAttribute('maxlength', '7');
  });

  it('keeps an invalid draft, reports undefined, and swaps the help', () => {
    const onColor = vi.fn();
    render(<Harness initial="#112233" onColor={onColor} />);
    const text = screen.getByLabelText('Hex');
    expect(screen.getByText('Use a hex value.')).toBeInTheDocument();

    fireEvent.change(text, { target: { value: '#12' } });
    expect(onColor).toHaveBeenLastCalledWith(undefined);
    expect(text).toHaveValue('#12');
    expect(screen.getByText('Enter a valid hex.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pick')).toHaveValue('#112233');
  });

  it('follows the native picker and an external value', () => {
    const onColor = vi.fn();
    const { rerender } = render(<HexColorField id="hex" value="#112233" onChange={onColor} pickerLabel="Pick" textLabel="Hex" placeholder="#000000" />);

    fireEvent.change(screen.getByLabelText('Pick'), { target: { value: '#445566' } });
    expect(onColor).toHaveBeenLastCalledWith('#445566');
    expect(screen.getByLabelText('Hex')).toHaveValue('#445566');

    rerender(<HexColorField id="hex" value="#AABBCC" onChange={onColor} pickerLabel="Pick" textLabel="Hex" placeholder="#000000" />);
    expect(screen.getByLabelText('Hex')).toHaveValue('#AABBCC');
  });
});

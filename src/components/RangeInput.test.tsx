import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RangeInput } from './RangeInput';

function fillOf(element: HTMLElement): { percent: string; ratio: string } {
  return {
    percent: element.style.getPropertyValue('--range-fill'),
    ratio: element.style.getPropertyValue('--range-fill-ratio')
  };
}

describe('RangeInput', () => {
  it('renders a native range input', () => {
    render(<RangeInput aria-label="Size" value={5} onChange={() => {}} />);
    expect(screen.getByRole('slider', { name: 'Size' })).toHaveAttribute('type', 'range');
  });

  it.each([
    { min: undefined, max: undefined, value: 0, percent: '0%', ratio: '0' },
    { min: undefined, max: undefined, value: 50, percent: '50%', ratio: '0.5' },
    { min: undefined, max: undefined, value: 100, percent: '100%', ratio: '1' },
    { min: '0', max: '1', value: 0.25, percent: '25%', ratio: '0.25' },
    { min: 1, max: 9, value: 3, percent: '25%', ratio: '0.25' },
    { min: 1, max: 9, value: 1, percent: '0%', ratio: '0' }
  ])('fills $percent for $value in [$min, $max]', ({ min, max, value, percent, ratio }) => {
    render(<RangeInput aria-label="Size" min={min} max={max} value={value} onChange={() => {}} />);
    expect(fillOf(screen.getByRole('slider'))).toEqual({ percent, ratio });
  });

  it('clamps values outside the range', () => {
    const { rerender } = render(<RangeInput aria-label="Size" min={10} max={20} value={5} onChange={() => {}} />);
    expect(fillOf(screen.getByRole('slider')).percent).toBe('0%');
    rerender(<RangeInput aria-label="Size" min={10} max={20} value={25} onChange={() => {}} />);
    expect(fillOf(screen.getByRole('slider')).percent).toBe('100%');
  });

  it('treats a non-finite value as zero', () => {
    render(<RangeInput aria-label="Size" min={-10} max={10} value="abc" onChange={() => {}} />);
    expect(fillOf(screen.getByRole('slider')).percent).toBe('50%');
  });

  it('merges className and style', () => {
    render(<RangeInput aria-label="Size" className="extra" style={{ width: '3rem' }} value={50} onChange={() => {}} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveClass('range-input', 'extra');
    expect(slider.style.width).toBe('3rem');
    expect(fillOf(slider).percent).toBe('50%');
  });

  it('forwards onChange and other input props', () => {
    const onChange = vi.fn();
    render(<RangeInput aria-label="Size" id="size" step="5" disabled={false} value={10} onChange={onChange} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('id', 'size');
    expect(slider).toHaveAttribute('step', '5');
    fireEvent.change(slider, { target: { value: '40' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

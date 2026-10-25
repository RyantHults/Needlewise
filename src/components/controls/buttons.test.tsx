import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActionButton } from './ActionButton';
import { SegmentedControl } from './SegmentedControl';
import { StepperButtons } from './StepperButtons';
import { ToolButton } from './ToolButton';

describe('SegmentedControl', () => {
  it('presses the current option and reports a choice', () => {
    const onChange = vi.fn();
    render(<SegmentedControl aria-label="Units" options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]} value="metric" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Metric' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Imperial' }));
    expect(onChange).toHaveBeenCalledWith('imperial');
  });

  it('can be named by a visible label', () => {
    render(<><span id="lbl">Display units</span><SegmentedControl aria-labelledby="lbl" className="extra" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => {}} /></>);

    expect(screen.getByRole('group', { name: 'Display units' })).toBeInTheDocument();
  });
});

describe('ActionButton', () => {
  it('forwards ref and props', () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(<ActionButton ref={ref} glyph="✎" caption="Rename" className="bottom-control" aria-label="Rename layer" aria-haspopup="dialog" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Rename layer' });

    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('can be disabled', () => {
    render(<ActionButton glyph="x" caption="Go" disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('ToolButton', () => {
  it('names and titles an icon button and reflects pressed', () => {
    render(<ToolButton label="Line" pressed><img alt="" /></ToolButton>);
    const button = screen.getByRole('button', { name: 'Line' });

    expect(button).toHaveAttribute('title', 'Line');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves aria-pressed off for action buttons', () => {
    render(<ToolButton label="Copy" disabled>Copy</ToolButton>);
    const button = screen.getByRole('button', { name: 'Copy' });

    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).toBeDisabled();
  });
});

describe('StepperButtons', () => {
  it('steps within bounds around its children', () => {
    const onChange = vi.fn();
    render(<StepperButtons label="color budget" value={5} min={1} max={6} onChange={onChange}><output>5</output></StepperButtons>);

    fireEvent.click(screen.getByRole('button', { name: 'Decrease color budget' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: 'Increase color budget' }));
    expect(onChange).toHaveBeenLastCalledWith(6);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('disables at the bounds', () => {
    const { rerender } = render(<StepperButtons label="n" value={1} min={1} max={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Decrease n' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase n' })).toBeEnabled();

    rerender(<StepperButtons label="n" value={3} min={1} max={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Increase n' })).toBeDisabled();
  });
});

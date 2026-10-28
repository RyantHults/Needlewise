import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMON_AIDA_COUNTS } from '../../domain';
import { AidaCountSelect } from './AidaCountSelect';
import { ColorField } from './ColorField';

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

describe('ColorField', () => {
  function Harness({ initial = '', onColor }: { initial?: string; onColor?: (color: string | undefined) => void }) {
    const [color, setColor] = useState(initial);
    return <ColorField id="hex" value={color} onChange={(next) => { onColor?.(next); if (next) setColor(next); }} pickerLabel="Pick" textLabel="Hex" placeholder="#C72B3B" help="Use a hex value." invalidHelp="Enter a valid hex." />;
  }
  const openPicker = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
    return screen.getByRole('dialog', { name: 'Pick' });
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports a valid draft, keeps it as typed, and normalizes on blur', () => {
    const onColor = vi.fn();
    render(<Harness onColor={onColor} />);
    const text = screen.getByLabelText('Hex');

    fireEvent.change(text, { target: { value: 'c72' } });
    expect(onColor).toHaveBeenLastCalledWith('#CC7722');
    expect(text).toHaveValue('c72');
    expect(text).toHaveAttribute('maxlength', '7');

    fireEvent.blur(text);
    expect(text).toHaveValue('#CC7722');
  });

  it('lets a long code be shortened and retyped without rewriting the draft', () => {
    const onColor = vi.fn();
    render(<Harness initial="#123456" onColor={onColor} />);
    const text = screen.getByLabelText('Hex');

    fireEvent.change(text, { target: { value: '#123' } });
    expect(text).toHaveValue('#123');
    fireEvent.change(text, { target: { value: '#123A' } });
    fireEvent.change(text, { target: { value: '#123AB' } });
    fireEvent.change(text, { target: { value: '#123ABC' } });
    expect(text).toHaveValue('#123ABC');
    expect(onColor).toHaveBeenLastCalledWith('#123ABC');
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
  });

  it('follows an external value', () => {
    const { rerender } = render(<ColorField id="hex" value="#112233" onChange={() => {}} pickerLabel="Pick" textLabel="Hex" placeholder="#000000" />);
    rerender(<ColorField id="hex" value="#AABBCC" onChange={() => {}} pickerLabel="Pick" textLabel="Hex" placeholder="#000000" />);
    expect(screen.getByLabelText('Hex')).toHaveValue('#AABBCC');
  });

  it('opens the picker from the swatch, and Escape closes it back to the swatch', () => {
    render(<Harness initial="#804040" />);
    const swatch = screen.getByRole('button', { name: 'Pick' });
    expect(swatch).toHaveAttribute('aria-expanded', 'false');

    openPicker();
    expect(swatch).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('slider', { name: 'Saturation and brightness' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Pick' })).not.toBeInTheDocument();
    expect(swatch).toHaveFocus();
  });

  it('changes the color from the keyboard on the area and the hue slider', () => {
    const onColor = vi.fn();
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Saturation and brightness' }), { key: 'ArrowRight' });
    expect(onColor).toHaveBeenLastCalledWith('#803F3F');
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight' });
    expect(hue).toHaveAttribute('aria-valuetext', 'Hue 1°');
    expect(onColor).toHaveBeenLastCalledWith('#80403F');
    expect(screen.getByLabelText('Hex')).toHaveValue('#80403F');
  });

  it('keeps the hue through grey', () => {
    const onColor = vi.fn();
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'PageUp' });
    const area = screen.getByRole('slider', { name: 'Saturation and brightness' });

    fireEvent.keyDown(area, { key: 'Home' });
    expect(onColor).toHaveBeenLastCalledWith('#808080');
    expect(hue).toHaveAttribute('aria-valuetext', 'Hue 15°');
    fireEvent.keyDown(area, { key: 'End' });
    expect(onColor).toHaveBeenLastCalledWith('#802000');
  });

  it('applies the RGB and HSL fields', () => {
    const onColor = vi.fn();
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'R' }), { target: { value: '255' } });
    expect(onColor).toHaveBeenLastCalledWith('#FF4040');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'G' }), { target: { value: '300' } });
    expect(onColor).toHaveBeenLastCalledWith('#FF4040');

    fireEvent.click(screen.getByRole('button', { name: 'HSL' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'L' }), { target: { value: '100' } });
    expect(onColor).toHaveBeenLastCalledWith('#FFFFFF');
  });

  it('reverts to the color it opened with', () => {
    const onColor = vi.fn();
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Hue' }), { key: 'PageUp' });
    expect(onColor).toHaveBeenLastCalledWith('#805040');

    fireEvent.click(screen.getByRole('button', { name: 'Revert to #804040' }));
    expect(onColor).toHaveBeenLastCalledWith('#804040');
  });

  it('offers the screen eyedropper only where the browser has one', async () => {
    const onColor = vi.fn();
    const { unmount } = render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();
    expect(screen.queryByRole('button', { name: 'Pick a colour from the screen' })).not.toBeInTheDocument();
    unmount();

    vi.stubGlobal('EyeDropper', class { open() { return Promise.resolve({ sRGBHex: '#123456' }); } });
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a colour from the screen' }));
    await waitFor(() => expect(onColor).toHaveBeenLastCalledWith('#123456'));
  });

  it('shows the screen eyedropper pressed while it is picking', async () => {
    let finish: (result: { sRGBHex: string }) => void = () => {};
    vi.stubGlobal('EyeDropper', class { open() { return new Promise((resolve) => { finish = resolve; }); } });
    render(<Harness initial="#804040" />);
    openPicker();
    const eyedropper = screen.getByRole('button', { name: 'Pick a colour from the screen' });
    expect(eyedropper).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(eyedropper);
    expect(eyedropper).toHaveAttribute('aria-pressed', 'true');
    finish({ sRGBHex: '#123456' });
    await waitFor(() => expect(eyedropper).toHaveAttribute('aria-pressed', 'false'));
  });

  it('drags the area to the color under the pointer', () => {
    const onColor = vi.fn();
    render(<Harness initial="#804040" onColor={onColor} />);
    openPicker();
    const area = screen.getByRole('slider', { name: 'Saturation and brightness' });
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(area, { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    expect(onColor).toHaveBeenLastCalledWith('#FF0000');
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(onColor).toHaveBeenLastCalledWith('#FFFFFF');
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(onColor).toHaveBeenLastCalledWith('#FFFFFF');
  });
});

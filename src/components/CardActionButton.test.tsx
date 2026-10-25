import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardActionButton } from './CardActionButton';

describe('CardActionButton', () => {
  it('renders a button with type="button" by default', () => {
    render(<CardActionButton>Rename</CardActionButton>);
    const button = screen.getByRole('button', { name: 'Rename' });

    expect(button).toHaveAttribute('type', 'button');
  });

  it('passes through button props', () => {
    const onClick = vi.fn();
    const { rerender } = render(<CardActionButton aria-label="Open x" onClick={onClick}>Open</CardActionButton>);

    fireEvent.click(screen.getByRole('button', { name: 'Open x' }));
    expect(onClick).toHaveBeenCalledOnce();

    rerender(<CardActionButton disabled>Open</CardActionButton>);
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardActionButton } from './CardActionButton';

describe('CardActionButton', () => {
  it('renders a button with the shared class and type="button" by default', () => {
    render(<CardActionButton>Rename</CardActionButton>);
    const button = screen.getByRole('button', { name: 'Rename' });

    expect(button).toHaveClass('card-action-button');
    expect(button).not.toHaveClass('card-action-button-armed');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('adds the armed modifier and keeps a custom class', () => {
    render(<CardActionButton armed className="extra">Delete</CardActionButton>);

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('card-action-button', 'card-action-button-armed', 'extra');
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

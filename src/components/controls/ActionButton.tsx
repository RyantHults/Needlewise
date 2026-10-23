import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  glyph: ReactNode;
  caption: ReactNode;
}

/** A glyph above a short caption. The caller's container CSS sizes it; name it with `aria-label`. */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton({ glyph, caption, type = 'button', ...rest }, ref) {
  return (
    <button {...rest} ref={ref} type={type}>
      <span aria-hidden="true">{glyph}</span><small>{caption}</small>
    </button>
  );
});

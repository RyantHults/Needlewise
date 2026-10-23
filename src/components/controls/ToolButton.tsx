import { type ButtonHTMLAttributes } from 'react';

interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The accessible name and tooltip, for buttons whose content is only an icon. */
  label?: string;
  pressed?: boolean;
}

export function ToolButton({ label, pressed, className, type = 'button', ...rest }: ToolButtonProps) {
  const classes = ['tool-option-button', className ?? ''].filter(Boolean).join(' ');
  return <button {...rest} type={type} className={classes} aria-label={label ?? rest['aria-label']} title={label ?? rest.title} aria-pressed={pressed ?? rest['aria-pressed']} />;
}

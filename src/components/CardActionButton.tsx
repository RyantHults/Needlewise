import { type ButtonHTMLAttributes } from 'react';

interface CardActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  armed?: boolean;
}

export function CardActionButton({ armed = false, className, type = 'button', ...rest }: CardActionButtonProps) {
  const classes = ['card-action-button', armed ? 'card-action-button-armed' : '', className ?? ''].filter(Boolean).join(' ');
  return <button {...rest} type={type} className={classes} />;
}

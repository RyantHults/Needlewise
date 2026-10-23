import { type HTMLAttributes } from 'react';

type NoticeProps = Omit<HTMLAttributes<HTMLParagraphElement>, 'role'>;

/** A failure the user must act on; announced immediately. */
export function ErrorNotice({ className, ...rest }: NoticeProps) {
  return <p {...rest} role="alert" className={['modal-error', className ?? ''].filter(Boolean).join(' ')} />;
}

/** A condition worth showing that is not a failure; announced politely. */
export function WarningNotice({ className, ...rest }: NoticeProps) {
  return <p {...rest} role="status" className={['modal-error', className ?? ''].filter(Boolean).join(' ')} />;
}

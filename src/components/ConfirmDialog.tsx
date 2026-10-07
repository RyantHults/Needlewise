import { useId, useRef } from 'react';
import { Modal, type ModalProps } from './Modal';

export interface ConfirmDialogProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  returnFocus?: ModalProps['returnFocus'];
}

export function ConfirmDialog({ eyebrow, title, message, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel, className, returnFocus }: ConfirmDialogProps) {
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      eyebrow={eyebrow}
      title={title}
      describedBy={messageId}
      className={className ? `catalog-dialog ${className}` : 'catalog-dialog'}
      initialFocus={cancelRef}
      returnFocus={returnFocus}
      onClose={onCancel}
    >
      <p className="modal-hint" id={messageId}>{message}</p>
      <div className="actions">
        <button ref={cancelRef} className="button button-secondary" type="button" onClick={onCancel}>{cancelLabel}</button>
        <button className="button button-primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

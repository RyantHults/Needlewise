import type { ReactNode } from "react";

interface Props {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}

export function ActionSection({ id, label, className, children }: Props) {
  return (
    <section className={className ? `action-section ${className}` : "action-section"} aria-labelledby={id}>
      <h3 id={id}>{label}</h3>
      {children}
    </section>
  );
}

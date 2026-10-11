interface Props {
  /** What is being counted: "All colors", or the focused color's name. */
  label: string;
  /** The focused color's swatch; absent for overall progress. */
  color?: string;
  /** The focused color's code or hex, shown before its name. */
  code?: string;
  completed: number;
  total: number;
}

/** Whole percent done, rounded down so 100% means every stitch is marked. */
export const progressPercent = (completed: number, total: number): number =>
  total === 0 ? 0 : Math.floor((completed / total) * 100);

/** Done/total and percent for the whole pattern or for the focused color. */
export function ProgressStrip({ label, color, code, completed, total }: Props) {
  const percent = progressPercent(completed, total);
  return (
    <section className="progress-strip" aria-label="Progress">
      <p className="progress-strip-label">
        {color && <span className="progress-strip-swatch" style={{ background: color }} aria-hidden="true" />}
        <span className="progress-strip-name">{code ? `${code} · ${label}` : label}</span>
        <strong className="progress-strip-percent">{percent}%</strong>
      </p>
      <div className="progress-strip-bar" role="progressbar" aria-label={`${code ? `${code} ${label}` : label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="progress-strip-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="progress-strip-count">
        {completed.toLocaleString()} of {total.toLocaleString()} stitches done
      </p>
    </section>
  );
}

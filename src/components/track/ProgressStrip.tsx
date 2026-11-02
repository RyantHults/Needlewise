interface Props {
  /** What is being counted: "All colors", or the focused color's name. */
  label: string;
  /** The focused color's swatch; absent for overall progress. */
  color?: string;
  /** The focused color's code or hex, shown before its name. */
  code?: string;
  completed: number;
  total: number;
  /** The header clears the color focus. */
  onClear: () => void;
}

/** Whole percent done, rounded down so 100% means every stitch is marked. */
export const progressPercent = (completed: number, total: number): number =>
  total === 0 ? 0 : Math.floor((completed / total) * 100);

/** The expanded row of the Track rail: done/total and percent for the whole pattern or one color. */
export function ProgressStrip({ label, color, code, completed, total, onClear }: Props) {
  const percent = progressPercent(completed, total);
  return (
    <section className="progress-strip" aria-label="Progress">
      <button type="button" className="progress-strip-label" aria-label={`${code ? `${code} ${label}` : label}, ${percent}% done`} aria-pressed="true" onClick={onClear}>
        {color && <span className="progress-strip-swatch" style={{ background: color }} aria-hidden="true" />}
        <span className="progress-strip-name">{code ? `${code} · ${label}` : label}</span>
        <strong className="progress-strip-percent">{percent}%</strong>
      </button>
      <div className="progress-strip-bar" role="progressbar" aria-label={`${code ? `${code} ${label}` : label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="progress-strip-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="progress-strip-count">
        {completed.toLocaleString()} of {total.toLocaleString()} stitches done
      </p>
    </section>
  );
}

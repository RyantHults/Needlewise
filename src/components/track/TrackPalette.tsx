import type { PaletteEntry, PatternMetrics } from '../../domain';
import { paletteProgress } from '../../application/progress';
import { progressPercent } from './ProgressStrip';

interface Props {
  palette: readonly PaletteEntry[];
  metrics: PatternMetrics | null;
  /** The focused palette id, or `null` when every color is in play. */
  focused: number | null;
  onFocus: (paletteId: number | null) => void;
  /** The entry's code or hex, with the brand when codes collide across catalogs. */
  codeFor: (entry: PaletteEntry) => string;
}

/**
 * The pattern's colors as large swatches, each with its percent done. Tapping
 * a color focuses it; tapping the focused color again clears the focus.
 */
export function TrackPalette({ palette, metrics, focused, onFocus, codeFor }: Props) {
  const used = metrics ? palette.map((entry) => ({ entry, progress: paletteProgress(metrics, entry.id) })).filter(({ progress }) => progress.totalComponents > 0) : [];
  if (used.length === 0) return <p className="track-palette-empty">This pattern has no stitches to track yet.</p>;
  return (
    <ul className="track-palette" aria-label="Colors">
      {used.map(({ entry, progress }) => {
        const percent = progressPercent(progress.completedComponents, progress.totalComponents);
        const pressed = entry.id === focused;
        const code = codeFor(entry);
        return (
          <li key={entry.id}>
            <button
              type="button"
              className="track-swatch"
              aria-pressed={pressed}
              aria-label={`${code} ${entry.name}, ${percent}% done`}
              onClick={() => onFocus(pressed ? null : entry.id)}
            >
              <span className="track-swatch-chip" style={{ background: entry.color }} aria-hidden="true" />
              <span className="track-swatch-text" aria-hidden="true">
                <span className="track-swatch-code">{code}</span>
                <span className="track-swatch-name">{entry.name}</span>
              </span>
              <span className="track-swatch-percent" aria-hidden="true">{percent}%</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

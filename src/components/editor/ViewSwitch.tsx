export type PatternView = 'edit' | 'track';

const VIEWS: readonly (readonly [PatternView, string])[] = [
  ['edit', 'Edit'],
  ['track', 'Track']
];

interface Props {
  current: PatternView;
  onNavigate?: (view: PatternView) => void;
}

/** The header switch between a pattern's pages. */
export function ViewSwitch({ current, onNavigate }: Props) {
  return (
    <nav className="view-switch" aria-label="Pattern view">
      {VIEWS.map(([view, label]) => (
        <button
          key={view}
          type="button"
          className={`view-switch-item${view === current ? ' view-switch-item-current' : ''}`}
          aria-current={view === current ? 'page' : undefined}
          onClick={() => {
            if (view !== current) onNavigate?.(view);
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

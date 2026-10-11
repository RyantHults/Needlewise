export function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="icon-button editor-export"
      type="button"
      aria-label="Export pattern"
      title="Export pattern"
      onClick={onClick}
    >
      <svg data-icon="download" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="gear-button"
      type="button"
      aria-label="Open settings"
      title="Settings"
      onClick={onClick}
    >
      ⚙
    </button>
  );
}

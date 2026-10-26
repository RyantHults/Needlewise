import { Icon } from "../controls/Icon";

export function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="icon-button editor-export"
      type="button"
      aria-label="Export pattern"
      title="Export pattern"
      onClick={onClick}
    >
      <Icon name="download" />
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
      <Icon name="settings" />
    </button>
  );
}

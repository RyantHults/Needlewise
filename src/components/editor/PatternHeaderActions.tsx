import { Icon, type IconName } from "../controls/Icon";

interface HeaderIconButtonProps {
  icon: IconName;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function HeaderIconButton({ icon, label, title = label, disabled, onClick }: HeaderIconButtonProps) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

export function ExportButton({ onClick }: { onClick: () => void }) {
  return <HeaderIconButton icon="download" label="Export pattern" onClick={onClick} />;
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return <HeaderIconButton icon="settings" label="Open settings" title="Settings" onClick={onClick} />;
}

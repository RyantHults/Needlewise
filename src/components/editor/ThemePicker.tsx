import { useEffect, useId, useRef, useState } from "react";
import { THEME_OPTIONS, type ThemeId } from "../app-theme";
import { nextRovingIndex } from "../controls/roving";
import { useDismissable } from "../dismiss";

const THEME_GROUPS = [...new Set(THEME_OPTIONS.map((option) => option.group))];

interface ThemePickerProps {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}

/** Five role colours of a theme, resolved from its `data-theme-preview` block. System stands for two themes, so it has none. */
function ThemeChips({ id }: { id: ThemeId }) {
  if (id === "system") return null;
  return (
    <span className="theme-chips" data-theme-preview={id} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((chip) => <span key={chip} className="theme-chip" />)}
    </span>
  );
}

/** Theme listbox: a trigger card showing the current theme, opening a grouped list of themes with colour chips. Name it with the element `#theme-label`. */
export function ThemePicker({ value, onChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const valueId = `${baseId}-value`;
  const current = THEME_OPTIONS.find((option) => option.id === value);

  const options = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  useDismissable({ open, refs: [list, trigger], onDismiss: () => setOpen(false), returnFocus: trigger });
  useEffect(() => {
    if (!open) return;
    const selected = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.focus();
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const choose = (id: ThemeId) => {
    setOpen(false);
    onChange(id);
    trigger.current?.focus();
  };
  const rove = (event: React.KeyboardEvent) => {
    const items = options();
    const next = nextRovingIndex(event.key, items.indexOf(globalThis.document.activeElement as HTMLElement), items.length, "vertical");
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="theme-picker">
      <button
        ref={trigger}
        type="button"
        className="theme-picker-card theme-picker-trigger"
        aria-labelledby={`theme-label ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <span id={valueId}>{current?.label}</span>
        <ThemeChips id={value} />
        <span className="theme-picker-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={list} id={listId} className="theme-picker-list popover-menu" role="listbox" aria-labelledby="theme-label" onKeyDown={rove}>
          {THEME_GROUPS.map((group, index) => {
            const headingId = `${baseId}-group-${index}`;
            return (
              <div key={group} role="group" aria-labelledby={headingId}>
                <div className="theme-picker-group-label" id={headingId}>{group}</div>
                {THEME_OPTIONS.filter((option) => option.group === group).map((option) => (
                  <div
                    key={option.id}
                    className="theme-picker-card"
                    role="option"
                    aria-selected={option.id === value}
                    tabIndex={option.id === value ? 0 : -1}
                    onClick={() => choose(option.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      choose(option.id);
                    }}
                  >
                    <span>{option.label}</span>
                    <ThemeChips id={option.id} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

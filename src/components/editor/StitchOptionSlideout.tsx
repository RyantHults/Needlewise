import type { ReactNode } from "react";
import doubleArrowIcon from "../../assets/editor-tools/double-arrow.svg";

// Vite inlines a small svg as a data URI that holds raw spaces and quotes, which an unquoted url() rejects.
const maskUrl = `url(${JSON.stringify(doubleArrowIcon)})`;

export type StitchOption<T extends string> = { value: T; label: string };

interface Props<T extends string> {
  /** The slideout is only rendered while its stitch kind is the active one. */
  active: boolean;
  groupLabel: string;
  options: readonly StitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The stitch-type button this slideout sits beside. */
  children: ReactNode;
}

/**
 * Wraps a stitch-type button and, while active, slides a small set of option
 * buttons out to its right inside one tinted pill so the pair reads as a unit.
 */
export function StitchOptionSlideout<T extends string>({ active, groupLabel, options, value, onChange, children }: Props<T>) {
  return (
    <span className={active ? "stitch-slideout stitch-slideout-active" : "stitch-slideout"}>
      {children}
      {active && (
        <span className="stitch-slideout-options" role="group" aria-label={groupLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              className="tool-option-button stitch-slideout-option"
              type="button"
              aria-label={option.label}
              title={option.label}
              aria-pressed={value === option.value}
              onClick={() => onChange(option.value)}
            >
              <span
                className={`stitch-direction-icon${option.value === "\\" ? " stitch-direction-icon-backslash" : ""}`}
                style={{ maskImage: maskUrl, WebkitMaskImage: maskUrl }}
                aria-hidden="true"
              />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogDefinition, CatalogRecord } from "../catalog";
import { normalizeHexColor } from "../domain/color";
import { ColorField } from "./controls/ColorField";
import { nextRovingIndex } from "./controls/roving";

export interface CatalogColorPickerProps {
  catalogs: readonly CatalogDefinition[];
  defaultCatalogId: string;
  /** Preselects this catalog's tab, when it is installed. */
  initialCatalogId?: string;
  /** Preselects the chip color; otherwise the catalog's first color. */
  initialColor?: CatalogRecord | null;
  /** What the catalogs hold, used in the accessible names: "thread" or "bead". */
  noun: string;
  /** Whether a catalog color is listed; it must be stable between renders. The selection falls back to the first listed color. */
  include: (color: CatalogRecord, catalog: CatalogDefinition) => boolean;
  /** The selected chip's detail lines. */
  detail: (color: CatalogRecord, catalog: CatalogDefinition) => ReactNode;
  /** Rendered beside the search, given the catalog whose tab is selected. */
  filter?: (catalog: CatalogDefinition) => ReactNode;
  /** Lays out the listed colors. */
  renderResults: (results: CatalogResults) => ReactNode;
  /** The chip button's text and aria-label prefix: "Add", "Swap" or "Use". */
  verb: string;
  onPickCatalogColor: (color: CatalogRecord, catalog: CatalogDefinition) => void;
  /** Rendered last inside the box, given the catalog whose tab is selected. */
  children?: (catalog: CatalogDefinition | undefined) => ReactNode;
}

/** What a results renderer is given: the listed colors and the selection. */
export interface CatalogResults {
  catalog: CatalogDefinition;
  colors: readonly CatalogRecord[];
  selected: CatalogRecord | null;
  onSelect: (color: CatalogRecord) => void;
}

export interface CustomColorSectionProps {
  /** The selected catalog tab, matched against the typed hex. */
  catalog: CatalogDefinition | undefined;
  initialCustomHex?: string;
  onPickCustomColor: (hex: string, catalogMatch: CatalogRecord | undefined, catalog: CatalogDefinition | undefined) => void;
  customActionLabel: (hex: string | null, catalogMatch: CatalogRecord | undefined, catalog: CatalogDefinition | undefined) => string;
}

export type ThreadColorPickerProps = Omit<CatalogColorPickerProps, "noun" | "include" | "detail" | "filter" | "renderResults" | "children"> & Omit<CustomColorSectionProps, "catalog">;

/** The thread picker: the catalogs plus custom hex entry. Callers reset it by remounting it with a new `key`. */
export function ThreadColorPicker({ initialCustomHex, onPickCustomColor, customActionLabel, ...catalogProps }: ThreadColorPickerProps) {
  return (
    <CatalogColorPicker {...catalogProps} noun="thread" include={includeAll} detail={threadDetail} renderResults={renderThreadResults}>
      {(catalog) => <CustomColorSection catalog={catalog} initialCustomHex={initialCustomHex} onPickCustomColor={onPickCustomColor} customActionLabel={customActionLabel} />}
    </CatalogColorPicker>
  );
}

const includeAll = () => true;

function threadDetail(color: CatalogRecord, catalog: CatalogDefinition) {
  return <span>{catalog.association.brandLabel} · #{color.code}</span>;
}

function renderThreadResults({ catalog, colors, selected, onSelect }: CatalogResults) {
  return (
    <ColorGrid label="Available thread colors">
      {colors.map((color) => (
        <ColorSwatchButton key={`${catalog.association.catalogId}:${color.sourceId}`} color={color} label={`${color.name}, color ${color.code}`} pressed={selected?.sourceId === color.sourceId} onSelect={onSelect} />
      ))}
    </ColorGrid>
  );
}

/** A list of color swatches. */
export function ColorGrid({ label, children }: { label: string; children: ReactNode }) {
  return <div className="catalog-color-grid" role="list" aria-label={label}>{children}</div>;
}

/** One selectable swatch in a `ColorGrid`. */
export function ColorSwatchButton({ color, label, pressed, onSelect }: { color: CatalogRecord; label: string; pressed: boolean; onSelect: (color: CatalogRecord) => void }) {
  return (
    <div role="listitem">
      <button className="catalog-color-button" type="button" aria-label={label} aria-pressed={pressed} onClick={() => onSelect(color)}>
        <span className="catalog-color-swatch" style={{ background: color.hex }} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The catalog tabs, search, color grid and selected-color chip shared by every
 * color picker. Callers reset it by remounting it with a new `key`.
 */
export function CatalogColorPicker({
  catalogs,
  defaultCatalogId,
  initialCatalogId,
  initialColor,
  noun,
  include,
  detail,
  filter,
  renderResults,
  verb,
  onPickCatalogColor,
  children,
}: CatalogColorPickerProps) {
  const isInstalled = (catalogId: string) => catalogs.some((item) => item.association.catalogId === catalogId);
  const firstColor = (catalogId: string) => catalogs.find((item) => item.association.catalogId === catalogId)?.search("", { limit: 1 })[0] ?? null;
  const [selectedCatalogId, setSelectedCatalogId] = useState(() =>
    initialCatalogId !== undefined && isInstalled(initialCatalogId) ? initialCatalogId : defaultCatalogId,
  );
  const [query, setQuery] = useState("");
  const [selectedColor, setSelectedColor] = useState<CatalogRecord | null>(() => initialColor ?? firstColor(selectedCatalogId));
  const pickerCatalog = catalogs.find((item) => item.association.catalogId === selectedCatalogId);
  const catalogResults = useMemo(
    () => pickerCatalog?.search(query).filter((color) => include(color, pickerCatalog)) ?? [],
    [query, pickerCatalog, include],
  );
  const installedCatalogIds = catalogs.map((item) => item.association.catalogId).join("\u0000");
  useEffect(() => {
    if (catalogs.some((item) => item.association.catalogId === selectedCatalogId)) return;
    setSelectedCatalogId(defaultCatalogId);
    setQuery("");
  }, [installedCatalogIds, defaultCatalogId, selectedCatalogId]);
  useEffect(() => {
    if (
      selectedColor &&
      catalogResults.some((color) => color.sourceId === selectedColor.sourceId)
    )
      return;
    setSelectedColor(catalogResults[0] ?? null);
  }, [catalogResults, selectedColor]);
  const selectCatalog = (catalogId: string) => {
    if (catalogId === selectedCatalogId) return;
    setSelectedCatalogId(catalogId);
    setQuery("");
    setSelectedColor(firstColor(catalogId));
  };
  return (
    <div className="catalog-box">
      <div className="catalog-selection" aria-label={`Selected ${noun} color`} role="group" aria-live="polite">
      {selectedColor ? (
        <>
          <span
            className="catalog-selection-swatch swatch"
            style={{ background: selectedColor.hex }}
            aria-hidden="true"
          />
          <span className="catalog-selection-details">
            <strong>{selectedColor.name}</strong>
            {pickerCatalog && detail(selectedColor, pickerCatalog)}
          </span>
          <button
            className="small-action"
            type="button"
             aria-label={`${verb} ${selectedColor.name}`}
               onClick={() => pickerCatalog && onPickCatalogColor(selectedColor, pickerCatalog)}
            disabled={!pickerCatalog}
          >
             {verb}
          </button>
        </>
      ) : (
        <span className="catalog-selection-empty">No color selected</span>
      )}
    </div>
    {catalogs.length > 0 ? <div className="catalog-tabs-area">
      <div className="catalog-tabs" role="tablist" aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)} catalogs`}>
        {catalogs.map((item) => <button
          key={item.association.catalogId}
          id={`editor-catalog-tab-${item.association.catalogId}`}
          className="catalog-tab"
          type="button"
          role="tab"
          aria-selected={selectedCatalogId === item.association.catalogId}
          aria-controls="editor-catalog-panel"
          tabIndex={selectedCatalogId === item.association.catalogId ? 0 : -1}
          onClick={() => selectCatalog(item.association.catalogId)}
          onKeyDown={(event) => {
            const index = catalogs.findIndex((catalog) => catalog.association.catalogId === item.association.catalogId);
            const nextIndex = nextRovingIndex(event.key, index, catalogs.length, "horizontal");
            if (nextIndex === null) return;
            event.preventDefault();
            if (nextIndex === index) return;
            const nextCatalog = catalogs[nextIndex];
            selectCatalog(nextCatalog.association.catalogId);
            window.setTimeout(() => document.getElementById(`editor-catalog-tab-${nextCatalog.association.catalogId}`)?.focus(), 0);
          }}
        >{item.association.brandLabel}</button>)}
      </div>
      {pickerCatalog && <div
        id="editor-catalog-panel"
        className="catalog-tabpanel"
        role="tabpanel"
        aria-labelledby={`editor-catalog-tab-${pickerCatalog.association.catalogId}`}
      >
        <label htmlFor="catalog-search">Search {pickerCatalog?.association.brandLabel ? `${pickerCatalog.association.brandLabel} catalog` : "catalog"}</label>
        <input
          id="catalog-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Name or ${pickerCatalog?.association.brandLabel ?? "catalog"} code`}
          disabled={!pickerCatalog}
          aria-label={`Search ${pickerCatalog?.association.brandLabel ? `${pickerCatalog.association.brandLabel} catalog` : "catalog"}`}
        />
        {filter?.(pickerCatalog)}
        {renderResults({ catalog: pickerCatalog, colors: catalogResults, selected: selectedColor, onSelect: setSelectedColor })}
        {!catalogResults.length && (
          <p className="catalog-empty" role="status">
            No matching colors.
          </p>
        )}
      </div>}
    </div> : <p className="catalog-unavailable" role="status">Catalog unavailable</p>}
    {children?.(pickerCatalog)}
    </div>
  );
}

/** Custom hex entry, matched against the selected catalog. */
export function CustomColorSection({ catalog, initialCustomHex = "#000000", onPickCustomColor, customActionLabel }: CustomColorSectionProps) {
  const [customColor, setCustomColor] = useState<string | undefined>(() => normalizeHexColor(initialCustomHex));
  const customCatalogColor = customColor ? catalog?.getByHex(customColor) : undefined;
  const actionLabel = customActionLabel(customColor ?? null, customCatalogColor, catalog);
  return (
    <section className="custom-color-section" aria-labelledby="custom-color-title">
      <h3 id="custom-color-title">Custom color</h3>
      <ColorField
        id="custom-color-hex"
        className="custom-color-fields-compact"
        value={customColor ?? ""}
        onChange={setCustomColor}
        pickerLabel="Choose custom color"
        textLabel="Hex color"
        placeholder="#C72B3B"
        help="Use a three- or six-digit hex value."
        invalidHelp="Enter a 3- or 6-digit hex color."
      />
      <button
        className="small-action custom-color-action"
        type="button"
         disabled={!customColor}
        aria-label={actionLabel}
         onClick={() => customColor && onPickCustomColor(customColor, customCatalogColor, catalog)}
      >
        {actionLabel}
      </button>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { CatalogDefinition, CatalogRecord } from "../catalog";
import { normalizeHexColor } from "../domain/color";
import { HexColorField } from "./controls/HexColorField";
import { nextRovingIndex } from "./controls/roving";

export interface ThreadColorPickerProps {
  catalogs: readonly CatalogDefinition[];
  defaultCatalogId: string;
  /** Preselects this catalog's tab, when it is installed. */
  initialCatalogId?: string;
  /** Preselects the chip color; otherwise the catalog's first color. */
  initialColor?: CatalogRecord | null;
  initialCustomHex?: string;
  /** The chip button's text and aria-label prefix: "Add", "Swap" or "Use". */
  verb: string;
  onPickCatalogColor: (color: CatalogRecord, catalog: CatalogDefinition) => void;
  onPickCustomColor: (hex: string, catalogMatch: CatalogRecord | undefined, catalog: CatalogDefinition | undefined) => void;
  customActionLabel: (hex: string | null, catalogMatch: CatalogRecord | undefined, catalog: CatalogDefinition | undefined) => string;
}

/**
 * The catalog tabs, search, color grid and custom hex entry shared by every
 * thread color picker. Callers reset it by remounting it with a new `key`.
 */
export function ThreadColorPicker({
  catalogs,
  defaultCatalogId,
  initialCatalogId,
  initialColor,
  initialCustomHex = "#000000",
  verb,
  onPickCatalogColor,
  onPickCustomColor,
  customActionLabel,
}: ThreadColorPickerProps) {
  const isInstalled = (catalogId: string) => catalogs.some((item) => item.association.catalogId === catalogId);
  const firstColor = (catalogId: string) => catalogs.find((item) => item.association.catalogId === catalogId)?.search("", { limit: 1 })[0] ?? null;
  const [selectedCatalogId, setSelectedCatalogId] = useState(() =>
    initialCatalogId !== undefined && isInstalled(initialCatalogId) ? initialCatalogId : defaultCatalogId,
  );
  const [query, setQuery] = useState("");
  const [selectedColor, setSelectedColor] = useState<CatalogRecord | null>(() => initialColor ?? firstColor(selectedCatalogId));
  const [customColor, setCustomColor] = useState<string | undefined>(() => normalizeHexColor(initialCustomHex));
  const pickerCatalog = catalogs.find((item) => item.association.catalogId === selectedCatalogId);
  const catalogResults = useMemo(
    () => pickerCatalog?.search(query) ?? [],
    [query, pickerCatalog],
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
  const customCatalogColor = customColor ? pickerCatalog?.getByHex(customColor) : undefined;
  const actionLabel = customActionLabel(customColor ?? null, customCatalogColor, pickerCatalog);
  return (
    <div className="catalog-box">
      <div className="catalog-selection" aria-label="Selected thread color" role="group" aria-live="polite">
      {selectedColor ? (
        <>
          <span
            className="catalog-selection-swatch swatch"
            style={{ background: selectedColor.hex }}
            aria-hidden="true"
          />
          <span className="catalog-selection-details">
            <strong>{selectedColor.name}</strong>
             <span>{pickerCatalog?.association.brandLabel} · #{selectedColor.code}</span>
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
      <div className="catalog-tabs" role="tablist" aria-label="Thread catalogs">
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
        <div className="catalog-color-grid" role="list" aria-label="Available thread colors">
        {pickerCatalog && catalogResults.map((color) => (
         <div role="listitem" key={`${pickerCatalog.association.catalogId}:${color.sourceId}`}>
          <button
            className="catalog-color-button"
            type="button"
             aria-label={`${color.name}, color ${color.code}`}
             aria-pressed={selectedColor?.sourceId === color.sourceId}
            onClick={() => setSelectedColor(color)}
          >
            <span
              className="catalog-color-swatch"
              style={{ background: color.hex }}
              aria-hidden="true"
            />
          </button>
        </div>
      ))}
      {!catalogResults.length && (
        <p className="catalog-empty" role="status">
          No matching colors.
        </p>
      )}
        </div>
      </div>}
    </div> : <p className="catalog-unavailable" role="status">Catalog unavailable</p>}
    <section className="custom-color-section" aria-labelledby="custom-color-title">
      <h3 id="custom-color-title">Custom color</h3>
      <HexColorField
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
         onClick={() => customColor && onPickCustomColor(customColor, customCatalogColor, pickerCatalog)}
      >
        {actionLabel}
      </button>
    </section>
    </div>
  );
}

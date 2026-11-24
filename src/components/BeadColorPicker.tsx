import { useCallback, useState } from "react";
import { beadKindOf, beadSizes, type BeadKind, type CatalogDefinition, type CatalogRecord } from "../catalog";
import { beadKindLabel, beadSizeHeading } from "./bead-kind";
import { CatalogColorPicker, ColorGrid, ColorSwatchButton, type CatalogResults } from "./ThreadColorPicker";
import { SegmentedControl } from "./controls/SegmentedControl";

export interface BeadColorPickerProps {
  catalogs: readonly CatalogDefinition[];
  defaultCatalogId: string;
  /** "Add" or "Swap". */
  verb: string;
  /** The bead being swapped: the filter starts on its size and the chip compares against it. */
  swapping?: BeadKind;
  onPickCatalogColor: (color: CatalogRecord, catalog: CatalogDefinition) => void;
}

const ALL_SIZES = "all";

function kindOfColor(color: CatalogRecord, catalog: CatalogDefinition) {
  return beadKindOf({ catalogId: catalog.association.catalogId, sourceId: color.sourceId });
}

/** The bead picker: the catalogs with a size filter, and results grouped by size. Callers reset it by remounting it with a new `key`. */
export function BeadColorPicker({ swapping, ...catalogProps }: BeadColorPickerProps) {
  const [sizeId, setSizeId] = useState(swapping?.size.id ?? ALL_SIZES);
  const include = useCallback(
    (color: CatalogRecord, catalog: CatalogDefinition) => {
      const kind = kindOfColor(color, catalog);
      return kind !== undefined && (sizeId === ALL_SIZES || kind.size.id === sizeId);
    },
    [sizeId],
  );
  const detail = (color: CatalogRecord, catalog: CatalogDefinition) => {
    const kind = kindOfColor(color, catalog);
    if (!kind) return null;
    const current = swapping?.size.diameterMm;
    const comparison = current === undefined || current === kind.size.diameterMm ? null : `${kind.size.diameterMm > current ? "Larger" : "Smaller"} than the current bead (${kind.size.diameterMm} mm vs ${current} mm)`;
    return (
      <>
        <span>{catalog.association.brandLabel} · #{color.code} · {beadKindLabel(kind)}</span>
        {comparison && <span>{comparison}</span>}
      </>
    );
  };
  return (
    <CatalogColorPicker
      {...catalogProps}
      noun="bead"
      include={include}
      detail={detail}
      filter={(catalog) => (
        <SegmentedControl
          className="bead-size-filter"
          aria-label="Bead size"
          value={sizeId}
          onChange={setSizeId}
          options={[{ value: ALL_SIZES, label: "All" }, ...beadSizes(catalog).map((size) => ({ value: size.id, label: size.label }))]}
        />
      )}
      renderResults={renderBeadResults}
    />
  );
}

function renderBeadResults({ catalog, colors, selected, onSelect }: CatalogResults) {
  return (
    <div className="catalog-color-groups">
      {beadSizes(catalog).map((size) => {
        const group = colors.filter((color) => kindOfColor(color, catalog)?.size.id === size.id);
        if (!group.length) return null;
        const heading = beadSizeHeading(size);
        return (
          <section key={size.id}>
            <h4 className="catalog-color-group-heading" aria-hidden="true">{heading}</h4>
            <ColorGrid label={heading}>
              {group.map((color) => {
                const series = kindOfColor(color, catalog)!.series;
                return (
                  <ColorSwatchButton key={`${catalog.association.catalogId}:${color.sourceId}`} color={color} label={`${color.name}, ${series}, color ${color.code}`} pressed={selected?.sourceId === color.sourceId} onSelect={onSelect} />
                );
              })}
            </ColorGrid>
          </section>
        );
      })}
    </div>
  );
}

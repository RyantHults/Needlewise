import { describe, expect, it } from "vitest";
import type { CatalogDefinition } from "../../catalog";
import type { PaletteEntry } from "../../domain";
import { paletteCodeFor } from "./palette-code";

const entry = (id: number, color: string, catalog?: { catalogId: string; code: string }) =>
  ({ id, color, active: true, catalog }) as unknown as PaletteEntry;
const catalogs = [
  { association: { catalogId: "dmc", brandLabel: "DMC" } },
  { association: { catalogId: "anchor", brandLabel: "Anchor" } },
] as unknown as CatalogDefinition[];

describe("paletteCodeFor", () => {
  it("uses the catalog code without a brand when the code is unique", () => {
    const a = entry(1, "#000000", { catalogId: "dmc", code: "310" });
    expect(paletteCodeFor(a, [a], catalogs)).toEqual({ code: "310", label: "310" });
  });

  it("brands entries whose code is shared across catalogs", () => {
    const a = entry(1, "#000000", { catalogId: "dmc", code: "310" });
    const b = entry(2, "#111111", { catalogId: "anchor", code: "310" });
    expect(paletteCodeFor(a, [a, b], catalogs)).toEqual({ brand: "DMC", code: "310", label: "DMC 310" });
    expect(paletteCodeFor(b, [a, b], catalogs).label).toBe("Anchor 310");
  });

  it("does not brand when the same catalog repeats a code", () => {
    const a = entry(1, "#000000", { catalogId: "dmc", code: "310" });
    const b = entry(2, "#111111", { catalogId: "dmc", code: "310" });
    expect(paletteCodeFor(a, [a, b], catalogs).brand).toBeUndefined();
  });

  it("falls back to the normalized hex for custom colors", () => {
    const a = entry(1, "#abc");
    expect(paletteCodeFor(a, [a], catalogs)).toEqual({ code: "#AABBCC", label: "#AABBCC" });
  });

  it("returns the raw color when it is not a hex", () => {
    const a = entry(1, "teal");
    expect(paletteCodeFor(a, [a], catalogs).code).toBe("teal");
  });
});

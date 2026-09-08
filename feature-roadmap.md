# Cross-Stitch App Feature Roadmap

## Existing solutions

| Product | Strongest features | Gaps / opportunity |
| --- | --- | --- |
| [FlossCross](https://flosscross.com/) | Browser-based designer, image-to-chart conversion, manual editing, DMC's 498 colors, source-image overlay, textured WebGL preview, autosave, and OXS import/export. | No documented completion tracker, stylus workflow, cloud sync, or confirmed PDF export. |
| [Stitch Fiddle](https://www.stitchfiddle.com/en) | Mature browser chart editor supporting cross-stitch and adjacent crafts. | Public docs do not clearly establish progress tracking, image conversion, realistic preview, stylus support, or detailed floss catalogs. |
| [Pic2Pat](https://www.pic2pat.com/index.en.php) | Simple image-upload-to-chart conversion, dimensions/count selection, floss quantity estimate, downloadable printable output. | Converter rather than a full editor: no evident manual design, tracking, tracing, stylus, or realistic rendering. Images are uploaded to its servers. |
| [Pattern Keeper](https://patternkeeper.app/) | Strong Android pattern-reading/tracking workflow: mark stitches complete, progress/counts remaining by color, symbol search, 10×10 selection, parked-thread markers, continuous page view. | Not a designer; centered on imported PDFs. Backstitch/fractional-stitch support and scans are limited; iOS remains in development. |
| Markup R-XP | Widely known in the PDF markup/tracking category. | Its official site was unavailable during research, so current feature claims need hands-on validation. |
| WinStitch / MacStitch | Long-standing desktop chart-design family; interoperates with FlossCross OXS files. | Desktop-oriented; current official feature details were not verifiable in this research pass. |

Public user/download counts were not consistently available, so these are the most established and representative products rather than a strict ranked list.

## Features

### Essential

#### 1. Pattern editor

- Infinite-feeling zoom/pan grid; grid intervals, center marks, and page boundaries.
- Full, half, quarter, three-quarter, petite, backstitch, French knot, bead, and specialty stitches.
- Pencil, fill, line, shape, selection, copy/paste, mirror, rotate, erase, undo, and redo.
- Symbol, color, grayscale, and combined chart modes.

#### 2. Stylus-first drawing

- Apple Pencil, Surface Pen, and generic-pointer support.
- Draw continuous stitch runs rather than requiring one click per cell.
- Palm rejection, pen/gesture shortcuts, two-finger pan/zoom, and configurable snap-to-grid behavior.
- Mouse and keyboard workflows remain first-class.

#### 3. Thread and palette system

- DMC at launch; extensible Anchor, Madeira, Cosmo, and custom catalogs.
- Thread ID, name, color approximation, usage count, skein estimate, and shopping list.
- Automatic palette extraction/mapping from an image.
- Palette size limits, near-duplicate detection, color replacement, and cross-brand conversion.

#### 4. Image-to-pattern and tracing

- Import, crop, rotate, resize, enhance, and optionally remove backgrounds.
- Control finished stitch dimensions, fabric count, maximum colors, floss brand, dithering, and palette merging.
- Background reference layer with adjustable opacity and lock state for tracing.
- Every automated change should be reversible and manually editable.

#### 5. Completion tracking

- Mark individual stitches, rows, blocks, or pages complete.
- Progress percentage, daily totals, remaining stitches by thread/section, notes, and parked-thread markers.
- Keep project progress separate from pattern design history so pattern edits do not destroy tracked work.

#### 6. PDF export

- Print-quality multi-page PDFs with overview, legend, symbols, page numbering, overlap, center marks, notes, dimensions, and materials list.
- Color and high-contrast black-and-white variants.
- PDF import is also high value, since many stitchers already own purchased PDF patterns.

### Major differentiators

#### 7. Realistic stitched preview

- Fast interactive fabric/thread preview plus a high-quality export render.
- Fabric type/color/count, stitch direction, coverage, stitch style, lighting, and thread reflectance controls.
- Present this as a visual approximation: thread appearance changes materially with real lighting and fabric.

#### 8. Offline-first web app

- Installable PWA, local autosave, backups, cloud sync, cross-device recovery, and a durable exportable project format.
- Prefer in-browser image processing where feasible; clearly disclose any server upload.

#### 9. Navigation and workflow

- Search/highlight by symbol, floss number, color, or note.
- Sections, current-working-area highlight, page/block navigation, and per-color visibility.
- Photos and notes for project state.

#### 10. Pattern quality checks

- Flag isolated stitches, unused colors, symbol collisions, excessive confetti, unconnected backstitch, and page-break issues.
- Surface estimated time, difficulty, density, and thread-use confidence.

### Expected modern features

#### 11. Accessibility

- Color-blind-safe palettes, high-contrast symbols, adjustable grid/symbol sizes, keyboard shortcuts, and screen-reader-friendly legends.

#### 12. Sharing and collaboration

- Private projects by default, read-only links, comments, editor permissions, version history, and optional designer/customer distribution.

#### 13. Materials planning

- Fabric calculator, needle and fabric notes, owned/purchased/missing thread status, and an exportable shopping list.

#### 14. Interoperability

- PDF, PNG/SVG preview, CSV shopping list, OXS where feasible, plus an open structured project export.

#### 15. Later enhancements

- AI-assisted cleanup/color simplification with inspectable, reversible suggestions.
- Marketplace/community features only after the authoring and tracking workflow is solid.

## Product position

The clearest gap is a browser-first product that combines **FlossCross-style authoring and conversion** with **Pattern Keeper-style completion tracking**, then makes **stylus drawing, offline sync, transparent palette conversion, and realistic stitch rendering** genuinely excellent.

## Sources

- [FlossCross](https://flosscross.com/)
- [Stitch Fiddle](https://www.stitchfiddle.com/en)
- [Pic2Pat](https://www.pic2pat.com/index.en.php)
- [Pattern Keeper](https://patternkeeper.app/)

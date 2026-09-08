# Cross-Stitch App MVP Implementation Plan

## 1. MVP goal

Deliver a browser-first, installable cross-stitch application where a user can create or import a pattern, edit it efficiently with a mouse or stylus, track their progress, preview its stitched appearance, and export a printable PDF.

The MVP is **local-first**: its core workflows work without an account or network connection. Projects are saved in the browser and can be exported/imported as a durable project archive. Cloud sync, collaboration, marketplace features, and real-time multiplayer editing are not MVP scope.

## 2. MVP scope

### Pattern authoring

- Create a pattern with configurable dimensions, fabric color/count, title, and notes.
- Edit a responsive grid with pan, zoom, center marks, and configurable grid intervals.
- Support full crosses, half crosses, quarter crosses, and backstitches.
- Provide pencil, eraser, fill, line, rectangle selection, copy/paste, undo, and redo.
- Show color, symbol, grayscale, and combined chart views.
- Support continuous stylus drawing, mouse drawing, and keyboard-accessible commands.

### Threads and palette

- Ship with a licensed/validated DMC catalog containing thread number, name, display color, symbol, and metadata.
- Add, remove, replace, and reorder palette entries without changing the pattern's logical meaning.
- Show usage counts, estimated skeins, and an exportable materials list.
- Provide automatic palette extraction and DMC mapping during image conversion.

### Image conversion and tracing

- Import supported raster images.
- Crop, rotate, and scale an image to target stitch dimensions.
- Convert a selected image into a draft pattern using a selectable color limit, DMC mapping, optional dithering, and basic cleanup.
- Present conversion output for review before it replaces pattern data.
- Add reference-image layers with opacity, visibility, ordering, and lock controls for tracing.

### Completion tracking

- Mark individual stitches, selected regions, or drawn runs as complete/incomplete.
- Show total progress, remaining stitches by color, and per-session/daily counts.
- Keep progress independent from palette color changes.
- Apply these MVP edit rules:

  | Pattern operation | Completion behavior |
  | --- | --- |
  | Change color | Preserve completion |
  | Change stitch type or geometry | Reset completion for the changed stitch |
  | Erase stitch | Remove completion |
  | Rotate or mirror | Transform completion with the stitch |
  | Crop | Discard completion outside the crop |

### Preview and export

- Provide a fast chart preview and a credible stitched preview with fabric color, stitch direction, and thread/fabric texture approximations.
- Clearly describe realistic rendering as an approximation, not physical color or reflectance proof.
- Export printable PDFs with overview, page coordinates, grid, symbols, legend, materials list, center marks, and configurable page overlap.
- Generate color and high-contrast symbol variants.
- Export very large patterns as independently generated PDF parts (for example, page ranges of 20–30 pages) rather than creating one large document in memory.

### Local-first product behavior

- Installable PWA with offline application-shell support.
- Local autosave, recovery of the prior valid revision, visible saving/failure state, and storage-quota warnings.
- Versioned project archive export/import containing the document, metadata, and optional source/reference images.
- No account, cloud backup, collaboration, marketplace, or PDF chart import in the MVP.

## 3. Product constraints and non-goals

- Local browser storage is convenient but is not a permanent backup guarantee; the UI must make archive export easy and communicate storage failures clearly.
- The first release will not promise cross-device sync or never-lossy storage.
- Do not use one React component, DOM node, SVG node, or database record per stitch.
- Do not require WebGL, WebGPU, a backend, or an account for core workflows.
- Do not claim exact floss color, luminosity, or printer fidelity.
- Do not support arbitrary remote image URLs, SVG import, or unvalidated project archives in the MVP.

## 4. Technical architecture

### Application stack

| Concern | MVP choice |
| --- | --- |
| UI | React, TypeScript, Vite |
| Editor renderer | Custom imperative Canvas 2D viewport renderer |
| Input | Pointer Events, pointer capture, coalesced-event support when available |
| Document model | Typed arrays plus sparse special-stitch records and command-based edits |
| Background compute | Web Workers for conversion, preview preparation, and export preparation |
| Local storage | IndexedDB via Dexie |
| Offline/install | PWA service worker and cached app assets |
| Image conversion | Worker-based TypeScript algorithms; add WASM only after profiling |
| PDF writer | `pdf-lib` behind an internal export interface, subject to worst-case validation |

### Document model

Keep the authoritative document independent from rendering and React state.

- Dense typed arrays store standard cell-based stitches, palette slots, and progress flags.
- Quarter stitches use an atomic quarter-cell position so several supported stitch primitives can be represented without ambiguous progress.
- Backstitches are sparse line-segment records with endpoints in sub-cell coordinates and their own completion state.
- Palette records use stable IDs; reordering a palette must not alter existing stitches.
- Reference-image layers are immutable image assets plus transforms, opacity, visibility, lock state, and order.
- Commands such as paint, erase, fill, remap palette, mark progress, rotate, and crop create compact undo patches, renderer invalidations, and debounced save requests.
- Progress attaches to atomic stitch identities. It is not inferred from the current palette color.

### Rendering model

Start with a viewport/level-of-detail Canvas renderer rather than a full tiled engine.

- At low zoom, draw a compact color atlas with image smoothing disabled.
- At normal and high zoom, draw only visible cells, symbols, grid lines, selection state, and sparse special stitches.
- Use dirty rectangles and one render per animation frame during editing.
- Draw reference images as bounded display proxies with affine transforms.
- Render a Canvas-based stitched approximation for the MVP. Evaluate a WebGL/PixiJS preview spike only after validating that its visual gain justifies a second renderer.
- Introduce tile caches only after profiling on target devices demonstrates a need.

### Stylus input model

- Use one canonical screen-to-grid coordinate transform.
- Capture the active pointer and use Pointer Events for pen, touch, and mouse input.
- Interpolate accepted samples using a supercover/Bresenham-style traversal so fast strokes do not leave gaps.
- Treat one stroke as one undo transaction; deduplicate touched stitches and store compact before/after values.
- Implement a documented gesture state machine for pen drawing, touch pan/zoom, pointer cancellation, suspension, and mode changes.
- Do not make pen pressure necessary for correct stitch placement.

### Persistence model

- Store metadata, binary document snapshots, source-image blobs, and recovery revisions in IndexedDB.
- Serialize saves using monotonically increasing document revisions so an old save cannot overwrite a newer edit.
- Save debounced committed gestures, not every pointer event.
- Use checksums and copy-on-write migrations for archive and schema evolution.
- Keep export/import as the user-controlled backup path.

## 5. Implementation phases

### Phase 0 — product rules and technical spikes

1. Write the versioned v1 pattern grammar and project archive schema.
2. Confirm DMC catalog licensing, attribution, source, and update policy.
3. Define the symbol set, print sizes, PDF page layout, overlap, and legend requirements.
4. Build short spikes for:
   - 500×500 and 1,000×1,000 Canvas pan/zoom/edit behavior;
   - fast stylus strokes on physical iPad and Android hardware;
   - worst-case multi-part PDF export on a low-memory target device;
   - DMC image conversion quality using a representative image corpus.
5. Establish supported browser/device versions and storage/privacy policy.

**Exit criteria:** the model, target devices, PDF approach, and conversion-quality baseline are approved.

### Phase 1 — local project foundation

1. Scaffold React/TypeScript/Vite application, design system, routing, and PWA shell.
2. Implement the typed-array document service, command layer, undo/redo patches, and derived palette/progress counts.
3. Implement Dexie persistence, save queue, recovery revision, quota monitoring, and project archive import/export.
4. Build accessible project creation, open, save-status, settings, and error/recovery UI.

**Exit criteria:** an offline project survives reload, interrupted saving, archive round-trip, and schema migration tests.

### Phase 2 — chart editor and accessibility

1. Build Canvas viewport rendering, transforms, level-of-detail drawing, grid, symbols, selection, and chart modes.
2. Implement full, half, quarter, and backstitch data/rendering/edit commands.
3. Add pointer/stylus drawing, interpolation, pan/zoom, erasing, fill, selection, copy/paste, and undo/redo.
4. Add keyboard navigation and editing, selected-cell semantic status, high-contrast symbols, and non-color-only states.

**Exit criteria:** gap-free drawing and predictable undo on physical stylus hardware; 500×500 charts remain responsive on supported devices.

### Phase 3 — palette and completion workflow

1. Integrate the DMC catalog and palette editor.
2. Add symbol assignment, color usage, skein estimates, and materials list.
3. Implement completion state, bulk marking, progress overlays, remaining-by-color counts, and daily/session statistics.
4. Enforce progress transformation/invalidation rules for geometry-changing commands.

**Exit criteria:** palette edits preserve progress as specified, and special-stitch completion is unambiguous.

### Phase 4 — image conversion and tracing

1. Add safe raster import with file signature, dimensions, decoded-pixel, and metadata validation.
2. Build worker-based crop/scale/orientation normalization and target-grid resampling.
3. Implement DMC color mapping, palette limits, optional dithering, and basic small-region cleanup.
4. Create a conversion-draft review and apply/reject workflow.
5. Add transformed reference-image layers for tracing.

**Exit criteria:** the image corpus produces reviewed, editable patterns without UI stalls or unsafe memory behavior.

### Phase 5 — preview and print export

1. Implement Canvas stitched preview with fabric/stitch settings and bounded-resolution rendering.
2. Build print-layout pagination and PDF generation in a worker.
3. Add color and monochrome exports, overview, legend, center marks, page coordinates, and multi-part output.
4. Validate generated PDFs in browser viewers, Adobe Reader, iPadOS workflows, and physical printers.

**Exit criteria:** worst-case supported exports complete offline without browser termination on target low-memory devices.

### Phase 6 — hardening and MVP release

1. Test offline cold starts, PWA updates, storage quota exhaustion, corrupt archives, malformed images, and interrupted saves.
2. Add content-security policy, safe text handling, no remote runtime scripts, and privacy-preserving telemetry policy.
3. Run VoiceOver and NVDA keyboard/semantic acceptance tests.
4. Profile memory, edit latency, pan/zoom frame time, image conversion, and PDF generation across the device matrix.
5. Publish user documentation for local storage, backup archives, conversion limitations, and preview/print color limitations.

## 6. MVP acceptance criteria

- A user can create, save locally, reopen, export, and import a pattern offline.
- A user can author and edit full, half, quarter, and backstitches with mouse, keyboard, and supported styluses.
- Continuous strokes do not leave gaps, and an entire stroke is undoable in one action.
- A 500×500 chart can pan, zoom, draw, track completion, and export without blocking normal interaction on the minimum supported tablet devices.
- A 1,000×1,000 chart has an explicit tested performance profile and degrades through level-of-detail rendering rather than failing due to DOM size.
- Image conversion runs off the main UI thread, produces a reviewable draft, and preserves user control over palette and cleanup choices.
- Completion remains stable across color changes and follows the documented rules for geometry-changing edits.
- PDF exports contain legible symbols, coordinates, legends, and materials information; large patterns can be generated as independently downloadable parts.
- Archive import rejects invalid, oversized, or hostile inputs; image imports have bounded resource usage.
- Core keyboard workflows and selected-stitch information are accessible without relying only on the Canvas surface.

## 7. Post-MVP candidates

- Account-based or encrypted cloud backup and snapshot sync.
- PDF chart import and importers for supported chart formats.
- Additional thread catalogs and user-defined catalogs.
- More stitch types, blends, beads, knots, and advanced specialty stitches.
- WebGL/PixiJS or WebGPU-enhanced realistic rendering after a value/performance spike.
- WASM optimization for proven image-conversion bottlenecks.
- Collaboration, sharing, publishing, marketplace, and designer tools.

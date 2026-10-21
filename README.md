# Needlewise

Needlewise is a browser-based cross-stitch pattern editor. Projects stay in the browser on the device where they are created.

## Run locally

Requires Node.js 22 and pnpm 10.15.0.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

## Use the app

- Create a blank pattern or make one from an image.
- Open projects from the Projects gallery. It is ordered by last edited date.
- Edit stitches, colors, symbols, reference images, and material settings.
- Import a pattern from a PDF chart.
- Export a pattern as a printable PDF.

## Data

Projects are stored locally in this browser. Clearing browser storage or using another browser/device does not carry projects over.

## Production build

```sh
corepack pnpm build
corepack pnpm exec vite preview
```

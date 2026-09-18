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
- Import `.needlewise` project archives.
- Download a project archive from the editor for backup or transfer.

## Data and backups

Projects are stored locally in this browser. Clearing browser storage or using another browser/device does not carry projects over.

Download `.needlewise` archives regularly and keep copies outside the browser. Import an archive to restore it on another supported browser or device.

## Production build

```sh
corepack pnpm build
corepack pnpm exec vite preview
```

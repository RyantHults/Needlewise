import type { Plugin } from 'vite';

/**
 * The dev-only /__symbols curation middleware. See scripts/symbol-picker-plugin.mjs.
 *
 * The implementation is plain Node ESM so the build can import it without
 * compiling TypeScript; this declaration is what lets vite.config.ts reference
 * it with a type.
 */
declare const symbolPickerPlugin: () => Plugin;

/** Fonts are served at `${FONT_ROUTE_PREFIX}/${slug}.ttf`. */
export declare const FONT_ROUTE_PREFIX: string;
/** Lists every vendored font with the url it is served at. */
export declare const REGISTRY_ROUTE: string;
/** Accepts a posted selection and writes the authored file. */
export declare const SAVE_ROUTE: string;

export default symbolPickerPlugin;

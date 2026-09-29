import type { Plugin } from 'vite';

/**
 * The dev-only /__symbols curation middleware. See scripts/symbol-picker-plugin.mjs.
 *
 * The implementation is plain Node ESM so the build can import it without
 * compiling TypeScript; this declaration is what lets vite.config.ts reference
 * it with a type.
 */
declare const symbolPickerPlugin: () => Plugin;

export default symbolPickerPlugin;

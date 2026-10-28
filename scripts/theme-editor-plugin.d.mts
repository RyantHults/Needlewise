import type { Plugin } from 'vite';

/**
 * The dev-only theme editor middleware. See scripts/theme-editor-plugin.mjs.
 *
 * The implementation is plain Node ESM like the other scripts; this
 * declaration is what lets vite.config.ts reference it with a type.
 */
declare const themeEditorPlugin: (options?: { themesDir?: string; registryPath?: string }) => Plugin;

/** Lists every theme with its tokens, in registry order. */
export declare const THEMES_ROUTE: string;
/** Writes a theme's edited values, label and group. */
export declare const SAVE_ROUTE: string;
/** Copies a theme to a new id and registers it. */
export declare const CREATE_ROUTE: string;
/** Unregisters a theme and deletes its file. */
export declare const DELETE_ROUTE: string;

export default themeEditorPlugin;

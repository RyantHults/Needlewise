import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

import symbolPickerPlugin from './scripts/symbol-picker-plugin.mjs';
import themeEditorPlugin from './scripts/theme-editor-plugin.mjs';

const pwaOptions = {
  registerType: 'prompt' as const,
  // Registration is owned by src/pwa.ts so the application can present an
  // update prompt and flush local edits before explicitly applying it.
  injectRegister: false as const,
  manifest: {
    name: 'Needlewise',
    short_name: 'Needlewise',
    description: 'A local-first workspace for creating and tracking cross-stitch patterns.',
    display: 'standalone' as const,
    background_color: '#f7f3ee',
    theme_color: '#f7f3ee',
    icons: [
      {
        // Relative manifest URLs resolve beneath Vite's configured base path.
        src: 'pwa-192.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: 'pwa-512.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  },
  workbox: {
    // `mjs` covers the pdf.js parser (about 1.3 MB, under workbox's 2 MiB
    // default limit), which is emitted as an asset so PDF import works offline.
    globPatterns: ['**/*.{js,mjs,css,html,svg,ico,png}'],
    cleanupOutdatedCaches: true,
    navigateFallback: 'index.html',
    // Only the generated application shell and static assets are precached.
    // No runtime caching is configured, so project data is never cached here.
    runtimeCaching: []
  }
};

function normalizeBasePath(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, '');
  return path ? `/${path}/` : '/';
}

function githubPagesBase(): string {
  const basePathOverride = process.env.VITE_BASE_PATH;
  if (basePathOverride !== undefined) {
    return normalizeBasePath(basePathOverride);
  }

  const githubRepository = process.env.GITHUB_REPOSITORY;

  // Only GitHub Actions project-site builds need a repository base path.
  // Local builds and other CI environments should continue to use the root.
  if (process.env.GITHUB_ACTIONS !== 'true' || !githubRepository) {
    return '/';
  }

  const [owner, repository] = githubRepository.split('/');
  if (!owner || !repository) {
    return '/';
  }

  return repository.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? '/'
    : `/${repository}/`;
}

export default defineConfig(({ mode }) => ({
  base: githubPagesBase(),
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keeps the symbol pool out of the main chunk (workbox's 2 MiB precache
          // limit) without top-level await, which would make module workers drop
          // messages posted before their evaluation finishes.
          groups: [{ name: 'symbol-pool', test: /src[\\/]symbols[\\/](outlines\.generated\.json|pool-asset\.ts)$/ }]
        }
      }
    }
  },
  plugins: [
    react(),
    // Serves the vendored font and writes selection.json for /__symbols. The
    // plugin declares `apply: 'serve'`, so it is absent from a production build.
    symbolPickerPlugin(),
    // Reads and writes src/themes/ and THEME_OPTIONS for the dev-only theme editor.
    themeEditorPlugin(),
    ...(mode === 'test' ? [] : [VitePWA(pwaOptions)])
  ],
  // Tests read a fixed symbol pool rather than the curated one, which the build
  // regenerates whenever the selection changes.
  resolve: mode === 'test'
    ? {
        alias: {
          'virtual:pwa-register': resolve(process.cwd(), 'src/test/pwa-register-stub.ts'),
          './pool-asset': resolve(process.cwd(), 'src/symbols/outlines.fixture.generated.json')
        }
      }
    : undefined,
  server: {
    // Deliberately allow only this development tunnel, not arbitrary Host headers.
    allowedHosts: ['ozone-display-spore.ngrok-free.dev']
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: true
  }
}));

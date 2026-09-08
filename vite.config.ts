import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

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
    globPatterns: ['**/*.{js,css,html,svg,ico,png}'],
    cleanupOutdatedCaches: true,
    navigateFallback: 'index.html',
    // Only the generated application shell and static assets are precached.
    // No runtime caching is configured, so project data is never cached here.
    runtimeCaching: []
  }
};

function githubPagesBase(): string {
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
  plugins: [
    react(),
    ...(mode === 'test' ? [] : [VitePWA(pwaOptions)])
  ],
  resolve: mode === 'test'
    ? { alias: { 'virtual:pwa-register': resolve(process.cwd(), 'src/test/pwa-register-stub.ts') } }
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

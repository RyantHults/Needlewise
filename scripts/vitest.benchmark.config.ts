import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/benchmark-delete-history.bench.ts']
  }
});

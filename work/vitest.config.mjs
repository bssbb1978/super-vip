import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',          // one process per file: workerd isolates stay independent
    fileParallelism: true,
    reporters: ['default'],
  },
});

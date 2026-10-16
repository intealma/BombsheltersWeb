import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The tests share one database, so run the files one after another.
    fileParallelism: false,
  },
});

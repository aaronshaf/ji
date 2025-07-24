import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run integration tests with Vitest
    include: ['src/test/**/*.vitest.ts'],

    // Use Node.js environment for MSW compatibility
    environment: 'node',

    // Setup MSW before tests
    setupFiles: ['src/test/setup-msw-vitest.ts'],

    // Enable globals like describe, it, expect
    globals: true,

    // Reporter options
    reporters: ['default'],

    // Coverage settings (optional)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'src/test/**', '**/*.test.ts', '**/*.config.ts'],
    },
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

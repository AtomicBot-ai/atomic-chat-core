import { defineConfig } from 'vitest/config'

// Six test layers, see AGENTS.md §5. Unit tests live next to the code; the rest under test/.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'contract', include: ['test/contract/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
      {
        test: {
          name: 'app-e2e',
          include: ['test/app-e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
        },
      },
      {
        test: {
          name: 'runtime-compat',
          include: ['test/runtime-compat/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          environment: 'node',
          testTimeout: 600_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/contracts/**', 'src/cli/bin.ts'],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
    },
  },
})

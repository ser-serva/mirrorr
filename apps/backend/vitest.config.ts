import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use individual test isolation (each test gets a fresh module registry)
    // Important for SSE bus singleton tests
    isolate: true,
    // Run in Node.js environment (not jsdom)
    environment: 'node',
    // File patterns
    include: ['tests/**/*.test.ts'],
    // Global setup — sets test env vars before env.ts validation runs
    setupFiles: ['./tests/setup.ts'],
    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/worker.ts'],
    },
    // Timeouts: workflow tests with TestWorkflowEnvironment can take longer
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Global test setup
    globals: false,
  },
  resolve: {
    // Allow TypeScript path resolution without .js extension in imports
    // (Vitest handles this via oxc/vite transforms)
    conditions: ['import', 'default'],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Chrome + the shared test database: run files one at a time, and allow for browser start-up.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

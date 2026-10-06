import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The loader's integration test migrates and shares the test database, same reason as packages/applications.
    fileParallelism: false,
  },
});

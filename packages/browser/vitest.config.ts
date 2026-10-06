import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Session tests migrate and share the test database.
    fileParallelism: false,
  },
});

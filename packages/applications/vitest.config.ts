import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests migrate and share the test database, same reason as packages/application-package.
    fileParallelism: false,
  },
});

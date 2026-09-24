import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pipeline tests (Task 9+) migrate the shared test database and use shared MinIO.
    fileParallelism: false,
  },
});

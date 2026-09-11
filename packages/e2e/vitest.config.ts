import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each test in here boots a real server on an ephemeral port; the timeouts are
    // generous because a property test does fifty round trips.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // Statistical validation tests need enough samples to converge.
    testTimeout: 60_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/demo/**/*.test.ts"],
  },
});

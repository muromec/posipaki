import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/xfetch.ts",
    "src/hooks.ts",
    "src/plugins/debug-logger.ts",
    "src/plugins/tree-introspection.ts",
    "src/remote/index.ts",
    "src/remote/node.ts",
    "src/testing/index.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  fixedExtension: false,
});

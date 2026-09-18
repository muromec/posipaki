import { defineConfig } from "tsdown";

export default defineConfig({
  // Stated for the same reason the gateway config states it: it would otherwise be *inferred* as
  // the common base directory of these entries, so adding one entry somewhere else — a `tools/` or
  // a `packages/` path — would silently move every output file.  It is `src/`, and it stays `src/`.
  root: "src",
  entry: [
    "src/index.ts",
    "src/xfetch.ts",
    "src/hooks.ts",
    "src/plugins/debug-logger.ts",
    "src/plugins/tree-introspection.ts",
    "src/remote/index.ts",
    "src/remote/node.ts",
    "src/remote/gateway-cli.ts",
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

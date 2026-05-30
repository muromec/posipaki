import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/pipe.ts", "src/supervisor.ts", "src/xfetch.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  fixedExtension: false,
});

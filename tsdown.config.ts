import { defineConfig } from "tsdown";

// ── One command, two builds ─────────────────────────────────────────────────
//
// The first build is the package: eight entries, ESM, types, sharing what they share as chunks.
//
// The second builds the gateway — and only the gateway — because that one file is *copied* rather
// than imported: a kit stages it into an environment where nothing of ours is installed, so it has
// to be one module.  With a single entry there is nothing to share and nothing is split out, which
// is the same shape every package here already builds (`packages/*/tsdown.config.ts`).
//
// They cannot override each other, by construction: the gateway is *not* among the first build's
// entries, so no file is written twice — the eight entries and their chunks by one, the copied file
// by the other.  `scripts/check-dist.sh` holds the contract that matters (whatever produced
// `dist/remote/gateway-cli.js`, it must import nothing relative).
//
// Neither build cleans: they run together (tsdown starts its configs at once), so a pass that wiped
// `dist` could take the other's output with it.  `scripts/build.sh` removes the directory once,
// before tsdown is called.
//
// `root` is stated rather than inferred in both: it is computed as the common base directory of the
// entries, which is `src/` for eight of them and `src/remote/` for the gateway alone — one directory
// away from where the exports map points.  Stating it also means an entry added outside `src/` can
// never silently move every output file.

const shared = {
  root: "src",
  format: ["esm"],
  dts: true,
  clean: false,
  sourcemap: true,
  platform: "node",
  target: "node18",
  fixedExtension: false,
};

export default defineConfig([
  {
    ...shared,
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
  },
  {
    ...shared,
    entry: ["src/remote/gateway-cli.ts"],
    // No declarations: this entry is a *path* in the exports map, not a module anyone imports (the
    // client resolves it and the kit copies it), so types for it would be a file nobody asks for —
    // and one more place for the two builds to write at once.
    dts: false,
  },
]);

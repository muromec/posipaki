import { defineConfig } from "tsdown";

// ── The gateway, built alone ────────────────────────────────────────────────
//
// One entry, on purpose.  This is posipaki's relay, and a kit stages this file *by itself* into an
// environment where nothing of ours is installed — so it has to come out as one module.  The main
// build shares code between its entries (a chunk per shared module), which is right for a package a
// consumer installs and fatal for the one file a consumer copies: the chunk stays behind and the
// staged gateway dies of a missing import on the far side.
//
// With a single entry there is nothing to share, so nothing is split out — the same shape every
// package here already builds (`packages/*/tsdown.config.ts`).  `clean` is off so this pass does not
// wipe what the main build wrote, and `dts` is off because the main build already emitted the types.
// `scripts/check-dist.sh` refuses a dist where the gateway imports anything relative.
//
// `root` is stated rather than left to be inferred: it *is* inferred as the common base directory
// of the entries, which for the main build's nine entries is `src/`, and for this lone entry is
// `src/remote/` — so the first version of this file built a perfectly good bundle at
// `dist/gateway-cli.js`, one directory away from where the exports map points.  A stray like that is
// now a failing check rather than a published file (see `scripts/check-dist.sh`).
export default defineConfig({
  entry: ["src/remote/gateway-cli.ts"],
  root: "src",
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
  target: "node18",
  fixedExtension: false,
});

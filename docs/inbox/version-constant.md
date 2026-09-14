# Export the package version as a build-time constant

**Parked:** 2026-09-13 (from email-agent's environment-kit work)

**Implemented:** 2026-09-14, `6a21335` — `LIB_VERSION` in `src/version.ts`, exported from the package entry point and pinned to package.json by `src/version.test.ts`.  Inlined as a literal, so it survives bundling; the build derives nothing, the suite fails on drift.

## What

Export posipaki's own release version as a constant, so a consumer can tell which
posipaki a build speaks without reading a file or hardcoding a number:

    import { LIB_VERSION } from "posipaki";   // "0.33.0"

The name has to not collide: `VERSION` in `posipaki/remote` is already the
*protocol* version (`json.v1`) and it does not move between releases. Both are
needed, and they answer different questions — protocol compatibility versus which
build you are holding.

## Why

A consumer that stages artifacts onto a host it knows nothing about has to name
those artifacts after their identity, so two personas, two bundles or two posipaki
releases cannot land on each other's files. The application version comes from the
consumer's own package.json; the posipaki release has no source at all today.
email-agent works around it by hardcoding the number and pinning it with a test —
which only protects that one repository.

## Enforced at build time

- derive the constant from package.json during the build (tsdown), or check it and
  fail the build when they disagree;
- it must be a plain inlined string: consumers bundle posipaki into a single file
  that runs where there is no node_modules and no posipaki on disk, so it can never
  read the file system at runtime.

## Acceptance

- `import { LIB_VERSION } from "posipaki"` equals package.json's `version`;
- a test or build step fails when package.json and the constant disagree;
- the value survives bundling (`bun build --target=node`) with no fs access.

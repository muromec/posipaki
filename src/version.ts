// ── Library identity ───────────────────────────────────────────────────────
//
// posipaki's own release version, as a plain inlined string.  A consumer that
// stages artifacts onto a host it knows nothing about has to name those
// artifacts after which posipaki they speak, and the bundle that runs there has
// no node_modules and no posipaki on disk — it can never read a file to find out.
//
// It is not the protocol version: that is `VERSION` in ./remote (`json.v1`), and
// it does not move between releases.  The two answer different questions.
//
// version.test.ts pins this to package.json, so a release that forgets to bump it
// fails the suite rather than shipping a lie.

/** posipaki's release version.  Must equal package.json's `version`. */
export const LIB_VERSION = "0.32.1";

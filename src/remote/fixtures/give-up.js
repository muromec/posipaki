// ── a payload that never gets there ────────────────────────────────────────
// Started by the gateway, gone before it could open its channel: what a runtime
// missing a dependency looks like from the client's side.

process.stderr.write("polaris: cannot find module\n");
process.exit(2);

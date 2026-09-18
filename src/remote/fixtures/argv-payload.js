// ── a payload that says what it was started with ────────────────────────────
// Started by the gateway, gone before it could open its channel: what the caller's arguments
// look like from the payload's side of the seam, which is the only place they can be seen.

process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(2);

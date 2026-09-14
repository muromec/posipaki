// ── The policy, as arguments ───────────────────────────────────────────────
//
// What bwrap is told when the consumer says nothing more: everything read-only,
// one writable directory of its own, and namespaces cut off.  It is asserted as
// data, because that is what it is — the make-up of a sandbox is a list of
// arguments, and the interesting part is exactly which ones are there.

import { homedir } from "node:os";
import { expect, it } from "vitest";
import { sandboxArgs } from "./sandbox.js";

/** The argument to a flag, or null when the flag is not there at all. */
function valueOf(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 || at + 1 === args.length ? null : args[at + 1];
}

it("gives the payload a machine read-only and one directory it may write to", () => {
  const args = sandboxArgs();

  expect(args.slice(0, 9)).toEqual([
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ]);
  expect(valueOf(args, "--bind")).toBe(homedir());
  // The writable directory is also what HOME says in there, so a staged kit lands
  // where the outside expects it.
  expect(valueOf(args, "--setenv")).toBe("HOME");
  expect(args).toContain(homedir());
});

it("cuts the namespaces off and leaves nothing behind when we go", () => {
  const args = sandboxArgs();
  expect(args).toEqual(
    expect.arrayContaining(["--unshare-pid", "--unshare-uts", "--unshare-ipc"]),
  );
  expect(args).toEqual(expect.arrayContaining(["--die-with-parent", "--new-session"]));
  // The network is not taken away unless it is asked for: a tool that cannot
  // reach anything is a surprise, not a safety feature.
  expect(args).not.toContain("--unshare-net");
  expect(sandboxArgs({ network: false })).toContain("--unshare-net");
});

it("takes a writable home of its own, extra binds, and extra tmpfs", () => {
  const args = sandboxArgs({
    home: "/srv/agent",
    read: ["/etc/ssl"],
    write: ["/run/agent.sock"],
    tmpfs: ["/var/tmp"],
  });

  expect(args).toEqual(
    expect.arrayContaining(["--bind", "/srv/agent", "--setenv", "HOME", "/srv/agent"]),
  );
  expect(args).toEqual(expect.arrayContaining(["--ro-bind", "/etc/ssl", "/etc/ssl"]));
  expect(args).toEqual(expect.arrayContaining(["--bind", "/run/agent.sock", "/run/agent.sock"]));
  expect(args).toEqual(expect.arrayContaining(["--tmpfs", "/var/tmp"]));
  // The narrower binds come after the wide read-only one, so they win.
  expect(args.indexOf("--bind")).toBeGreaterThan(args.indexOf("--ro-bind"));
});

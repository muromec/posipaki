// ── The sandbox a payload gets when you say nothing more ───────────────────
//
// bwrap's arguments *are* the policy, and there is no safe default that is also
// useful: a payload needs a machine to run on, and the machine is ours.  What
// this builds is the smallest useful one — read-only everything, one writable
// directory of your own, its own /tmp and /dev and /proc, the process namespace
// cut off — and every part of it is a knob you can turn or ignore.
//
// The writable directory is also what `HOME` says inside, so a kit staged through
// the sandbox lands where the outside expects it and both sides see the same
// file.  Nothing here is copied: bwrap binds paths, so the sandbox and the
// machine share the filesystem where you allowed it.

import { homedir } from "node:os";

/** What to expose, and what to take away.  Everything here has a working default. */
export interface SandboxPolicy {
  /**
   * The one directory the payload may write to, inside and out, and what `HOME`
   * says in there.  Defaults to your home directory.  A kit is staged into it.
   */
  home?: string;
  /** Extra paths bound read-only, on top of `/`, which is already there. */
  read?: string[];
  /** Extra paths bound read-write.  For sockets, mounts, or a scratch directory. */
  write?: string[];
  /** Extra paths that get a fresh, empty tmpfs.  `/tmp` always does. */
  tmpfs?: string[];
  /** Whether the payload reaches the machine's network.  Defaults to true: tools that talk to the outside keep working, and `network: false` adds `--unshare-net`. */
  network?: boolean;
}

/**
 * The arguments for a sandbox that can run a payload and little else: the world
 * read-only, one directory of yours writable, its own `/dev`, `/proc` and
 * `/tmp`, and its own process, UTS and IPC namespaces.  It dies when we do.
 */
export function sandboxArgs(policy: SandboxPolicy = {}): string[] {
  const home = policy.home ?? homedir();
  const args = [
    // Everything, read-only, first: the narrower binds below win over it.
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    // The one place a payload may write, and the one it calls home.
    "--bind",
    home,
    home,
    "--setenv",
    "HOME",
    home,
  ];
  for (const path of policy.read ?? []) args.push("--ro-bind", path, path);
  for (const path of policy.write ?? []) args.push("--bind", path, path);
  for (const path of policy.tmpfs ?? []) args.push("--tmpfs", path);
  args.push(
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    // No process of ours outlives us, and nothing gets a terminal back.
    "--die-with-parent",
    "--new-session",
  );
  if (policy.network === false) args.push("--unshare-net");
  return args;
}

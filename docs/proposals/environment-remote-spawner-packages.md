# Remote actors in foreign environments — ssh and podman as packages

**Status:** delivered, short of the consumer's switch (step 5): the core's half, both
packages and the documentation page are in.  See the delivery list below.
**Follows:** [actor-remote.md](./actor-remote.md)

## Motivation

`posipaki/remote` runs an actor in another process on this machine and hands the
consumer a proxy that behaves like a local one. The next step out is a process on
*another* machine, or in a container: `ssh host …`, `podman exec …`. The seam supports
it — a spawner returns a `Channel`, and where that channel came from is the spawner's
business — but nothing upstream implements a way in.

One consumer does. email-agent's `src/environments` (~3 500 lines) runs its tool pool
over ssh and inside a podman container: staging, a gateway inside the environment, a
line wire over stdio, and a kit that a runtime is delivered as. All of it is written
against the seam, and none of it is specific to that application — the environment knows
nothing about email or tools. Every consumer that wants an actor in a container writes
the same thing again.

This proposal moves that work upstream as **one core addition and one package per way
in**. Decided with the consumer: a monorepo, and separate packages for ssh and podman,
each a wrapper around `exec`, each free to duplicate the other.

## What is missing, stated as two facts

Everything the consumer's environment code does follows from two properties of a foreign
execution context. Neither is an application fact:

1. **The only channel every way in gives you is the stdio of the command that gets you
   in.** A FIFO path created here does not exist there, and a path created there is not
   ours to open. So the wire is a pipe: our child's stdin and stdout.
2. **Nothing of ours is on the other side yet.** The actor's code has to arrive before it
   can run — and the step that delivers it cannot carry the wire, because its own stdin
   *is* the script.

The consequence is a two-stage spawn: a **stage** command that puts the payload somewhere
and reports what it found, then a **run** command whose stdin/stdout are the wire. Both
stages are `exec`; what differs between ssh and podman is the argv and where the payload
lands.

## Direction

### The core (`posipaki/remote/node`)

Three pieces, all node-only, all environment-agnostic:

| Piece | What it is |
| --- | --- |
| the stdio wire | a line transport over any readable/writable pair, output frames, error frames, the version handshake, and `clientChannel` / `serverChannel` on top of them |
| the relay | what runs *inside* the environment: it creates a private channel for the payload, starts it, carries frames between that channel and its own stdin/stdout, turns whatever the payload prints into output frames, and cleans up on every exit path |
| the kit vocabulary | how a runtime is delivered: a manifest with one hash per file, a `version.json` naming the build, the bootstrap script that writes them and reports back, and the parser for that report |

The relay is what makes fact 1 livable: the wire stays a pipe while the payload keeps its
own stdout free, so a payload that prints cannot corrupt the protocol.

These are the wire's node half, not a framework. Nothing in them knows what a "tool" is.

### The packages (`packages/*`)

One package per way in. All three exist now, in the same shape:

| Package | Way in | Exports |
| --- | --- | --- |
| `posipaki-remote-ssh` | `ssh [user@]host <cmd>` | `sshRemote` (a host, and the one command shape) |
| `posipaki-remote-bwrap` | `bwrap <policy> <cmd>` — the same machine, with less of it in reach | `bwrapRemote`, plus `sandboxArgs` (the policy it suggests) and `bwrapEntry`. No container actor: bwrap makes the sandbox for as long as the command runs, so there is no life to hand over |
| `posipaki-remote-podman` | `podman exec -i <container> <cmd>`, plus `run` / `rm` for the container's life | `containerActor` (a container, held and counted), `podmanRemote` (an existing container, staged into) and `podmanEnvironment` (both together) |

A package is a wrapper over `exec` and nothing else: it says how a command is reached
there — `entry(command)` — and the core's `gatewayClient` does every step after that (read
the payload and posipaki's gateway into one kit, stage it through the same channel, take
the runtime from its report, run `<runtime> <kit>/gateway.js <kit>/payload.js
--host-version=<app>@<version>`, and speak the client channel over the child's stdio).
Podman carries more than ssh, because a container has to exist, stay alive between calls
and be removable — that is the package's business, not the core's.

**The duplication turned out to be the wrong thing to keep.** Three copies of staging, of
the channel, of the kit and of the gateway's argv differed in exactly one thing — how a
command is reached — and every other line was a copy that could drift (the packages were
spelling `--worker=` themselves, against a parser in the core). What is shared now is
everything below the entry; what a package keeps is its command shape and, for podman, the
container's life. A new way in is one `entry` function and one package: `posipaki-remote-host`
(the same machine) is `hostRemote` in the core for that reason.

**Tests** assert the commands and what travels on stdin, against an injected host runner —
the pattern the consumer already uses (`HostRun`). No ssh or podman needs to be present to
run the suite. A real host is an opt-in integration test behind an env var.

### The consumer keeps

- `environments.yaml` and the persona wiring: which environment a persona may use, and
  which of those is its default;
- the payload — the pooled tool caller and the tool set. Tools are code, so their
  implementations travel as a bundle rather than as a schema;
- the `local` kind, including `local, user=…`: the same machine is not a foreign
  environment, and `sudo -n -u` needs no staging.

It loses `gateway.ts`, `stdio.ts`, `bootstrap.ts`, `staged.ts`, `spawner.ts` and the kit
half of `version.ts` to the core and the packages.

## Repo layout

posipaki becomes a workspace monorepo; the root stays the core package:

- the root `package.json` keeps the name `posipaki`, its exports map and its build, and
  gains `"workspaces": ["packages/*"]`;
- each package has its own `package.json`, a `tsconfig.json` extending the root, its own
  bundler entry and its own tests;
- `scripts/validate.sh` walks the workspaces, so the gate covers the whole tree
  (typecheck, lint, format, tests);
- versions move in lockstep with the core while the wire is the contract: a payload's only
  claim is which posipaki it speaks, so a package and the core it builds against are
  published together;
- names are unscoped, matching `posipaki` and its subpaths: `posipaki-remote-ssh`,
  `posipaki-remote-podman`;
- a package declares `posipaki` as a dependency like any other, and the tree resolves it
  without a release: the root's `tsconfig.json` maps the core's entry points at `src/`, so a
  package's tests and typecheck run against the working tree, and the root's `overrides`
  resolve the dependency to this checkout, so an install needs nothing published;
- `npm run build` at the root builds the tree — the core, then every package — because a
  release is one release.

## Delivery

1. the workspace skeleton — core untouched, gate green;
2. the stdio wire, the relay and the kit vocabulary into `posipaki/remote/node`, with the
   consumer's tests ported;
3. `posipaki-remote-ssh`, with its tests;
4. `posipaki-remote-podman`, with its tests — since reshaped into three pieces (a
   container's actor, the way in by name, and both together): see
   [container-lifetime.md](./container-lifetime.md);
5. the consumer switches its `ssh` and `container` kinds onto the packages and deletes
   what moved;
6. a page in posipaki-docs for running an actor somewhere else, and this document's status
   flipped.

## Open questions

- **Kit vocabulary: core or package?** Settled in the core: a package stages the kit and
  runs it, but the manifest, the script and the report belong to whoever delivers a
  payload, and both packages use them unchanged.
- **A container's life with more than one consumer.** Written down separately in
  [container-lifetime.md](./container-lifetime.md): what happens when one consumer starts the
  container and another joins, what an application-scoped name and a label buy, and which
  shapes are acknowledged but not built.
- **`local` and `sudo` later?** They stay in the consumer for now. If a second consumer
  wants them, they are a package like any other.
- **Versioning.** Lockstep, as assumed: a package declares `posipaki` as a dependency and
  ships with the core it builds against, because the wire version is the only
  compatibility claim a payload makes.

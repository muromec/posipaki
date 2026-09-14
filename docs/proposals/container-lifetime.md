# The container's life when there is more than one consumer

**Status:** design. One shape is built (`attached`, `collision: fail`); the rest is written
down here and not implemented, deliberately.
**Follows:** [environment-remote-spawner-packages.md](./environment-remote-spawner-packages.md)

## The question

*What if one consumer starts the container, another joins, then the first one exits?*

Today: the container is the first consumer's property and the second one borrows it. The
borrower's `ensureContainer` returns `null`, and that `null` is precisely "I hold nothing" —
no handle, so nothing to hand over, keep up or remove. When the owner leaves, by any route,
its stdin closes, the keepalive's reader sees EOF, `--rm` takes the container away, and the
borrower's `podman exec` channels die with it. The borrower recovers on its next spawn
(nothing is there, so it starts one and becomes the owner), but the live channel is gone.

That is defensible for as long as a container is one consumer's cache. It stops being
defensible once the same library runs in more than one application on one host.

## What a consumer is

An application, not posipaki. email-agent is one; another app using this package on the same
host is another, and it is a correction worth keeping: the two are not the same consumer, they
do not know each other, and nothing in the package may assume they cooperate.

## The vocabulary

| Word | Values | State |
| --- | --- | --- |
| lifetime | `attached` | built |
| | `managed` | acknowledged, not built |
| collision | `fail` | built (the default) |
| | `join` | acknowledged, not built |
| role | owner | built |
| | member | acknowledged, not built |
| | guest | acknowledged, not built |

**Ownership is a fact on the resource, not a reading of its name.** A container we create
carries podman labels: `posipaki=1`, a fingerprint of the spec (image, user, mounts, env,
runtime, relay — canonicalised and hashed) and the fingerprint's format version. The name is a
string somebody typed; a label is what lets us answer "is this ours, and is it built the way
we think?" before we `exec` into it, write a kit into its filesystem, or remove it.

## The shapes

### attached — the environment is a child of its consumers (built)

An *attached* `podman run --rm -i --name <n> <image> sh -c 'cat >/dev/null'` whose main
process only reads its stdin. While a consumer holds the write end, the container is up and
`podman exec` can open as many channels as it likes; when the holder goes, the reader sees EOF,
the main process exits, and `--rm` removes the container. Nothing has to remember to clean up.

### managed — the environment is the point (acknowledged, not built)

`podman run -d`, with a life independent of every consumer: guests are natural, the holder
question disappears, and so does the free cleanup — removal is explicit, or a TTL we opted
into. It is a different lifetime model rather than a flag on the first one, and the seam is one
field: asking for `managed` before it exists throws.

### collision — what "it is already there" means (policy settled, first half built)

A derived name is scoped to the consumer, so two applications do not collide by construction;
an explicit `container:` name is the caller asserting a name it owns, and there a collision is
always a failure unless the caller opted into joining. Meeting an existing container then has
three verdicts:

- labelled, fingerprint matches — ours, built as we expect: join (or, with membership, hold);
- labelled, fingerprint differs — a conflict, and it fails: a container built to another spec
  has no stage dir, maybe another runtime and user, so `exec` misbehaves subtly;
- unlabelled — foreign: fail. We do not stage into it, exec into it, or remove it.

`removeContainer` follows from this and should refuse an unlabelled container unless forced:
`podman rm -f` on a stranger is the sharp end of getting this wrong.

Two starts racing is the same family. Both probes see nothing, both start; the loser gets
"name already in use", its `waitForContainer` then succeeds on the winner's container, and it
returns a handle it does not own. It self-corrects on the next probe, and labels are what let
the loser know whose container it just found.

### roles — who holds it up

Under attached life a holder is not optional: the keepalive *is* the container's process, so a
container nobody holds has no life at all. That is why a guest is a role and not a lifetime
model:

- **owner** — started it, holds it, may remove it;
- **member** — joined it and holds, so it keeps the light on past the owner's exit; the last
  one out gives EOF (a FIFO with one writer per member is how the kernel can do the counting);
- **guest** — joined, holds nothing, never removes, never starts what it will not hold, and
  reports a container that goes rather than resurrecting it.

What exists today is the owner and an unnamed borrower: the second consumer joins, holds
nothing and cannot remove — and it differs from the guest below only in that it will start a
container when there is none.

Since the kit directory is written per consumer, joining also implies agreeing on what is
staged inside. That is the strongest argument for scoped names over sharing: a shared container
has a shared kit directory, and the last stager wins.

## Invariants

1. We never stage into, exec into or remove a container we cannot prove is ours.
2. Under attached life, holding is the only thing that keeps the container up; a consumer that
   will not hold may only join.
3. A shape that is nameable but not built fails loudly. Approximating it with the nearest built
   thing would be worse than not having it.

## The effort now

Small, and additive to what is there:

- app-scoped derived names, so a second application does not land on the first one's name;
- the labels, with the fingerprint and its version;
- `collision: fail` as the default, with an error that names the container and says what it
  looks like — unlabelled, or labelled with a different fingerprint;
- `removeContainer` refusing unlabelled containers unless forced;
- the richer fields present in the spec and the options, so the next shape is additive.

## Open questions

- **Is cross-consumer sharing real?** If the honest answer for a second consumer is "it gets its
  own name", membership never has to be built, and the FIFO stays what it is today: a
  transport.
- **Membership: writer count or lease?** A FIFO held open by each member counts holders in the
  kernel and self-cleans on a crash; a lease file needs liveness checks and a reaper. If
  membership is built, the FIFO is the shape to beat.
- **A guest when the container goes:** report and stop, or re-join on next use? The package
  should report; whether that is an error to the caller is the caller's business.
- **Managed removal:** explicit only, or a TTL we opt into?

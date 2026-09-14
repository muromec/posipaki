# A container and a way into it

**Status:** design settled, and built: the container actor, the connector by name, the copy
shape and the environment composite are in `posipaki-remote-podman`.  What this note keeps is
the shape of the thing and the list of what we deliberately did not build.
**Follows:** [environment-remote-spawner-packages.md](./environment-remote-spawner-packages.md)

## The question it started from

*What if one consumer starts the container, another joins, then the first one exits?*

The answer that survived is that this is two questions wearing one coat. A container has a life,
and a way into it does not — so they are separate pieces, and neither has to guess about the
other.

## The three pieces

| Piece | What it owns | What it does not |
| --- | --- | --- |
| `containerActor` | the container's life: it starts one, holds it, counts the consumers that retain it, lets it go at the end, and says when the container disappears | it does not adopt a container somebody else holds, and it knows nothing about what runs inside |
| `podmanConnector` / `podmanCopy` | the way in by name: an optional prepare step and a command, on the exec's own stdin/stdout | it does not start, hold or remove a container — no container, and podman's own words are the reason |
| `podmanEnvironment` | both together, for one actor | it is not a way to share: two actors that want one container ask the container actor for it |

The composite is there because "run this actor in a container of its own, and stop it when the
actor is done" is the common case; the pieces are there because it is not the only one.  In the
consumer (email-agent) that leaves exactly two cases:

- **share a container inside the agent** — one `containerActor` per name, retained by each
  consumer, started when the first arrives and stopped when the last leaves.  External processes
  that sideload into it are their own business, not ours;
- **run an actor in a container by name** — `podmanConnector`, and no container means failure.
  Nothing to check, nothing to adopt: podman says "no such container" and that is the answer.

Where *we* assume we manage the container's life — our own images, our own names — the actor is
started with `onConflict: "replace"`; where the container is somebody else's, it is left alone.

## What a taken name does

| `onConflict` | Behaviour |
| --- | --- |
| `fail` (default) | touches nothing, and says what it found: a name that is taken is a question for the consumer, not a guess for us |
| `reuse` | a wanted name gets a moment to be freed (a container goes a moment after its holder); if it is really held, run in it and hold nothing |
| `replace` | remove what is there and start our own — for containers we manage |

Adopting silently was the thing that had to go: it hands one consumer the use of a container
whose life another one owns, which is exactly the bug the question was about.

## The run seam

Everything about *what runs* is two knobs, which is also what the ssh package will adopt when it
settles:

- `prepare?` — runs once before the actor, in the container.  `podmanCopy` fills it in with the
  kit staging; an actor already in the image needs none;
- `command(args, prepared)` — the argv inside the container, given what prepare left behind.

That is the difference between "copies itself in" and "runs a pre-installed command in the
PATH", and nothing else in the package has to know which one it is.

## What we deliberately did not build

- **Ownership labels and a spec fingerprint.**  The label was there to answer "is this container
  ours?" — a question only the *consumer* can answer, and `onConflict` makes it answer it once
  instead of the package hashing a spec and guessing.
- **Membership across processes (a FIFO's writer count, a lease file).**  Sharing happens inside
  one agent, where a count in an actor is enough.  Two agents sharing one container through a
  container name is not a case we have.
- **A `managed` lifetime** (detached `-d`, TTL, an operator's long-lived box).  A container that
  outlives every consumer is an operator's machine, not a package's lifetime model; the
  attached life is the one with no cleanup code, which is why it is the one we have.
- **A guest role.**  With `reuse`, a guest is what the second consumer already is: it holds
  nothing, and it learns that the container went through `onGone` and `GONE`.

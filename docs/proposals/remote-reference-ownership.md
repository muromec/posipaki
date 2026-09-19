# posipaki: Who Owns a Reference

> **Status**: implemented on `main`, unreleased.  The approximation below is what 0.38 carries.

## The problem

A process that crossed the wire is a handle here: a name, the id one connection knows it by,
and the one thing that makes the id worth having — a way to put a frame on the wire with it.
Handles are shared.  A reference that arrives on a state, in a message or in the answer to a
call is the *same* handle every time, because a process is numbered once per connection and
never a second time.

So `release()` on its own was a lie in both directions.  It says "everyone stop": the far side
forgets the process and the binding here goes, which takes the process away from every other
holder — while a holder that merely drops a handle says nothing at all, and leaves the far side
holding it open for nobody.  Two questions had no answer: was this reference held before, and
does anybody still hold it.

## The approximation

A handle counts what keeps it.

- `holdRef()` keeps a reference and returns the handle, so a table of what is held reads as one
  line: `this.pvtRemoteRefsHeld.push(ref.holdRef())`.
- `releaseRef()` gives a count back.  Whoever gives the last one back lets the reference go —
  by telling the far side, when there is still something to ask; a process that has ended, or
  one whose connection went, has nothing left to be told, and what is dropped is the binding
  here.
- `refCount()` says how many times it has been kept.
- Nothing is heard from an unkept reference: `tune()`, `subscribe()` and `ready()` throw and say
  to call `holdRef()` or `releaseRef()`.  A reference with count zero is nothing in every sense
  that matters, and it says so wherever it is rendered or stringified: `UnstableReference`, in
  `util.inspect` and in JSON alike.

Two tables, filled by where a reference lands.

- **owned**: the references sitting in what a process holds.  A handle that receives a state
  takes the references inside it — `pvtHoldOwned` — because the thing holding them is here, and
  it gives the counts back when it is let go of itself.
- **transient**: the references that arrive on their way somewhere else, in a message
  (`receiveMessage`) or in an answer to a call (the surface a handle installs, and the one the
  proxy's own reflection installs).  They are not counted: nobody here asked for them, and
  whoever receives them is the one to deal with them.  They are remembered only so that one
  nobody ever keeps is let go of after all.

`release()` cascades: it gives back the counts of what it holds, and drops the transients that
are still at zero while leaving the ones somebody kept to them.

The far side is unchanged and needs no part of this: an id is allocated once per process and
never handed out again, so nothing that still names a process can come to mean another one.

## What falls out of it

- whoever receives a reference deals with it: a search releases what it does not hand back, and
  a caller releases what it was handed once it is done with it;
- what sits in a state is held by the handle that holds the state, so a lookup that finds that
  process hands back a reference that is already kept, and no one has to keep it again;
- reading what a handle holds is `await handle.ready()`, which asks for the state and settles
  when the first word of it is here.

## What it approximates

- references are found by walking plain objects and arrays in a value.  One sitting in a `Map`,
  a class instance or a closure is not seen, and a value of another kind is not walked at all.
- the count is per handle, not per consumer: two consumers handed the same handle and keeping it
  count twice, which is right; a consumer that keeps one without `holdRef()` leaks, the way any
  unclosed thing does.
- a transient is dropped when the handle that carried it is released, not when the receiver is
  done with it.  A reference that arrives in a message to a process of this side's own has no
  table to sit in at all: normal processes have no `retainRef`/`releaseRef` yet.
- a handle that has been let go of is left in the tables that named it, where it is skipped for
  being already released.

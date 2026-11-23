# The remote seam, on the distribution wire

Read-only note: `posipaki/src/remote/` is one way to put an actor behind a connection; this package is another. What
follows is what the two have in common, what the translation costs, and what is missing before an actor of one runtime
can be reached from the other. No code has been written from it.

## The seam, in the terms it uses

A connection carries JSON frames, one per line, each addressed to a process by `to: <id>`:

- `$proto` a version, then `$init {name, args}` for the connection's root;
- `$msg {fromName, body}` to a process, `$state <state>` about it, `$exit {code, state}` when it ends;
- `$stop`, `$pause`, `$resume`, `$release`, `$tune {streams}` — control *about* a process, deliberately not messages;
- `$r.methods`, `$r.call.<name> {seq, args}`, `$r.result.<name> {seq, value | error}` — reflection, answered by
  whoever holds the process;
- `$bad` and `$error` — a frame nobody could read, and a wire that cannot be spoken over;
- `{$p: {id, pname}}` — a process, by reference.

The ids belong to the connection: each side hands out its own, from one space split by parity (client odd, server
even), and each root is the first id of its own parity — 1 for the client, 0 for the server.

## The distribution wire, in the same terms

One connection per pair of *nodes*, not per session, carrying ETF terms: a control message (`DOP_SEND`, `DOP_REG_SEND`,
`DOP_EXIT`, monitors, links) and then the term it carries. A process is a pid: node name, id, serial, and the creation
value of the node that minted it. A name is an atom registered on that node.

## The mapping, and what each line costs

| the seam | the distribution wire | the cost |
| --- | --- | --- |
| a connection, its id space and parity | one connection per node pair; pids are global to the node | a handle's id must become a pid, and the connection-scoped numbering dissolves into the node's |
| `{$p: {id, pname}}` | a pid | `pname` has no slot: a pid addresses without a name, and a name is an atom registered on the node |
| `$init {name, args}` | nothing | a node is not a session. A root has to become a *registered name that answers* — a registry actor |
| `$msg {fromName, body}` | `DOP_SEND`/`DOP_REG_SEND` and a term | the body must be a term, and the sender is the control's `From` pid — `fromName` disappears |
| `$state` | nothing | a call: `inspect.getState` over reflection, or a message shaped like one |
| `$exit {code, state}` | a monitor's `DOWN`, or `DOP_EXIT` | the state rides in the reason; monitors are not implemented here yet |
| `$stop`, `$pause`, `$resume`, `$release`, `$tune` | nothing | mailbox control is not an Erlang feature. `stop` is an exit signal; the rest are either dropped or emulated by the process itself |
| `$r.call.<name> {seq, args}` | nothing | a call convention with a correlation id and a deadline. Erlang's own call is a convention too (`gen_server`), so ours has to be written down and lived with |
| `$proto` | the handshake, and the flags | the *frame vocabulary's* version has no slot in the handshake, so it needs a first message |
| `$bad` and `$error` | nothing: erts closes the connection on a packet it cannot read | per-frame resilience is lost; an adapter here must be stricter, not looser |
| blobs and streams by reference | a stream actor, addressed by pid | needs references written, which `terms.ts` refuses today by design |

## What is missing, in the order it blocks

1. **A term for a message.** A message is `{type, ...fields}`; ETF has tuples, lists, maps, atoms, binaries, pids. The
   mapping has to be canonical and total: `{TypeAtom, Map}` is the shape closest to both, and anything that cannot
   cross — a function, a promise, a class instance — must be refused with a sentence rather than flattened.
2. **A root.** `$init` says which definition a connection serves. A node has no such thing, so the serving side needs a
   registry: a name that answers "spawn this definition with these arguments" and hands back a pid. That is also what
   makes `fork`-over-the-wire real, and it is the piece `DOP_SPAWN_REQUEST` cannot give: that opcode names a module and
   a function, which is Erlang's vocabulary, not a TypeScript definition's.
3. **A call.** Reflection crosses as `$r.call.<name> {seq, args}` and is answered by seq. On this wire a call is a
   message to a pid carrying a correlation id, and the answer is a message back — with a deadline, because a dead peer
   otherwise waits forever. `waitResponse` is the same idea on this side, so the convention should be its shape.
4. **Monitors.** `$exit {code, state}` and `await proc.wait()` need `DOP_MONITOR_P`/`DOP_MONITOR_P_EXIT` (a ref, a DOWN
   with a reason), and supervision needs `DOP_LINK`/`DOP_EXIT`. Neither is implemented here; both are small, and the
   reference term is the one piece `terms.ts` refuses to write today.
5. **The control frames.** Decide per frame: `stop` becomes an exit signal; `pause`/`resume` have no mailbox to act on;
   `tune` has no equivalent (the seam can ask for less *about* a process, the distribution wire always says everything
   or nothing). Dropping them is a semantic loss and has to be stated, not hidden.
6. **Streams.** A blob or a stream crossing by reference needs an actor on the far side and a reference term to name it.

## What this wire has that the seam does not

- An **incarnation** in every pid. A proxy to a node that restarted is refused rather than delivered to whoever answers
  now, and the seam has nothing like it — a reference survives a restart and resolves to the new process.
- **One connection per node pair**, so two proxies to the same node share a channel and its ordering, and neither can
  starve the other by opening more.
- **A standard handshake**: the cookie, and a version negotiation that a peer from another language already implements.

## The first slice I would write

A registry actor (`name → pid`, and "spawn this definition"), the `{Type, Map}` message mapping, and the call
convention — in that order, each with its own tests, each its own file. Monitors come after, because `wait` is the
first thing a proxy needs and the last thing this package has.

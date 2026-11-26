# The surfaces, and the two levels

Status: built. The cluster holds configuration only, the node is the surface, and both directions of the protocol live in
it. `ServedProcess`, the runtime `Cluster` interface, `installCluster`, `clusterNamed`, `makeCluster`'s connection table and
`ErlangProxy` are gone. Nothing here is invented — every rule below is the wire's own, written down after measuring it
against a live node.

## The division

- **cluster** — configuration for a node, and the grammar of a name: `self`, `cookie`, `creation`, `flags`, `timeoutMs`,
  `locate`, `announce`, `epmd`. It holds no connection and no table.
- **node** — the surface: the listener, the connections to other nodes, the registration with the mapper at its host,
  pid translation, the monitors in both directions, the links, the names it serves, and the starts it asks for.
- **wire** — `frame`, `terms`, `control`, `messages`, `handshake`, `connection`, `listen`, `epmd`: grammar and
  transport. The node uses them, and nothing above the node knows a cookie or a length prefix.

A cluster without a node is configuration nobody runs: no node, no pids, no addresses. A client that does not want to
be found starts a node with `announce: false` and a port the OS picks.

## Two levels, one vocabulary

The node speaks the wire's words — pids, names, terms. The application speaks posipaki's — process handles.

| the node | what it writes |
| --- | --- |
| `send(pid, body)` | `{2, '', To}`, which carries no sender |
| `sendReg(name, ref, body, from: AnyProcess)` | `{6, pidOf(from), '', name}` |
| `watch(pid)`, `watchName(ref, name)` | `{19, From, ToProc, Ref}`, answered by `{21, FromProc, ToPid, Ref, Reason}` |
| `link(from: PidTerm, to: PidTerm)`, `unlink(from, to)` | `{1, From, To}`, `{4, From, To}` |
| `spawn(ref, {module, function, args})` | `{29, Ref, From, GL, {M, F, Arity}, []}` and the arguments after it |
| `pidOf(process: AnyProcess)` | the pid, and the table a `{2}` resolves against: an address this node answers at |
| `registerProcess(name, process)` | the table a `{6}` resolves against |

`ErlangProcess` is the application's handle on a process over there: an address, `send`, `monitor`, `kill`, and
`link(process)`. `wait()` is `monitor().ended`.

## What each verb needs locally

The wire decides this, not taste:

| verb | needs | why |
| --- | --- | --- |
| `send(pid, …)` | nothing | `{2, '', To}` has no sender field |
| `sendReg(…)` | a process | `{6, From, '', Name}` does, and the receiver is told who sent it |
| `monitor` | a pid of ours | the answer is found by `Ref`, so the pid is only an address |
| `kill` | a pid of ours | `{3, From, To, kill}` carries `From` as a header |
| `link` | **the process that dies** | `{3, To, From, Reason}` ends `From` on this side |

So a shallow ref carries **no** local process. `send`, `monitor` and `kill` need at most an address the node mints for
itself; `link` takes the process as an argument, because the same ref may be held by two actors and each would want its
own end joined.

`proxyOf(node, ref)` answers an `ActorDefinition`, and the node does the routing: the actor asks for its own pid in setup
(`node.pidOf(this.self)`, which is what serves it at that address), so what the other side sends to it arrives as
`{from?, body}` and is emitted up; a `SEND` in is forwarded with `ref.send`. It ends when `ref.monitor()` says so.

`ErlangProcess` is the one shallow ref: an address — a pid, or a name its node registered — and `send`, `monitor`, `kill`
and `link(process)`. `wait()` is `monitor().ended`. A name carries no sender, so `send` takes the process sending, and a
name cannot be exited or linked: those controls carry pids.

## What this deletes

`ServedProcess` (a hand-written mirror of posipaki's `AnyProcess`), the runtime `Cluster` interface, `installCluster`,
`clusterNamed`, `makeCluster`'s connection table, `ErlangProxy` and `RemoteProcess` — all gone.

## Open

- A name-addressed send says who sends it, and the caller passes the process at that call. A ref minted once and used by
  two actors therefore sends as whoever is asking at the time; whether a ref should instead carry its owner is open.
- A term a peer sends that this side cannot read — a bignum, so far — is complained about and dropped rather than
  flattened or refused at the connection.

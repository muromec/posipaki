# The surfaces, and the two levels

Status: built. The cluster holds configuration only, the node is the surface, both directions of the protocol live in it,
and the actor level above it is three makers over one body. `ServedProcess`, the runtime `Cluster` interface,
`installCluster`, `clusterNamed`, `makeCluster`'s connection table, `ErlangProxy`, `RemoteProcess`, `proxyOf` and its
`SEND` are gone. Nothing here is invented — every rule below is the wire's own, written down after measuring it against a
live node.

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
| `sendReg(name, ref, body, from: TermSender)` | `{6, senderPidOf(from), '', name}`: a process of this side is minted, a pid is relayed as it stands |
| `watch(pid)`, `watchName(ref, name)` | `{19, From, ToProc, Ref}`, answered by `{21, FromProc, ToPid, Ref, Reason}` |
| `link(from: PidTerm, to: PidTerm)`, `unlink(from, to)` | `{1, From, To}`, `{4, From, To}` |
| `spawn(ref, {module, function, args})` | `{29, Ref, From, GL, {M, F, Arity}, []}` and the arguments after it |
| `pidOf(process: AnyProcess)` | the pid, and the table a `{2}` resolves against: an address this node answers at |
| `registerProcess(name, process)` | the table a `{6}` resolves against |

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

## The actor level

`actor.ts` is one actor over one process on another node: what it is given goes to that process. Three makers are the
same body, and the difference is only where the address comes from.

| maker | where the address comes from |
| --- | --- |
| `makeErlangRef({node, process})` | written where the definition is |
| `makeErlangConnect()` | the fork's args, `{node, process}` |
| `makeErlangFactory({node, module, fname})` | `reach.spawn` starts `module:fname`, and the fork's args are that function's parameters |

`fname` states the arity, `there-spawner/1`, and a parameter count that disagrees with it is refused before the node is
asked. A local process may be one of the parameters: it crosses as its pid, which is how a started process is given
somewhere to answer.

In `ETF_RAW {body}` goes to the far process. `node.pidOf(this.self)` in setup mints the address this side serves the actor
at, and the actor ends when the far process ends, with the same reason. Nothing comes out of it: a term says where its
answer goes, so the layer composing the term puts `processTerm(this.self)` inside it and the answer arrives at that
process.

```
const peer = await this.fork(makeErlangRef({ node: where, process: "watcher" }));
await peer.send({ type: "ETF_RAW", body: tuple(processTerm(this.self), binary(Buffer.from("hi"))) });
```

Two handles, split where the wire is:

| | has | verbs |
| --- | --- | --- |
| `ErlangProcess` | a pid | `send(body)` (`{2}`, no sender), `monitor`, `kill`, `link(process)`, `wait` |
| `ErlangNamedProcess` | a name its node registered | `send(body, from)` (`{6}` names its sender), `monitor` (`{19}` takes a name) |

A name has no pid, so it is not exited and not linked: `{3}` and `{1}` carry pids.

`rpc(ref, {module, function, args})` runs one function on a node and answers what it answered: `{6, From, '', rex}`
carrying `{From, {call, M, F, A}}`, answered `{rex, From, Reply}`. Everything an application wants *asked* of a node goes
through it — `whereis` included — because the distribution protocol has no lookup of its own and the node knows no
question but the ones it is asked:

```ts
const pid = await node.rpc(ref, { module: "erlang", function: "whereis", args: [atom("robot")] });
```

## What this deletes

`ServedProcess` (a hand-written mirror of posipaki's `AnyProcess`), the runtime `Cluster` interface, `installCluster`,
`clusterNamed`, `makeCluster`'s connection table, `ErlangProxy`, `RemoteProcess`, `proxyOf` and its `SEND` — all gone.

## Open

- A name-addressed send says who sends it, and the caller passes the process at that call. A ref minted once and used by
  two actors therefore sends as whoever is asking at the time; whether a ref should instead carry its owner is open.
- A term a peer sends that this side cannot read — a bignum, so far — is complained about and dropped rather than
  flattened or refused at the connection.
- An actor stands for a far process and writes to it; what the far side answers is addressed by the term, not by the actor.
  Whether the actor should also own arrivals is open: with one message type both ways, a term to write and a term that
  arrived land in the same mailbox, and telling them apart would need the sender or a `from` in the message.

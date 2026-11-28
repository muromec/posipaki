# posipaki-epmd

Talk to an Erlang node over its own distribution protocol: ask epmd where a node listens, prove a cookie, and exchange
BEAM terms with it — from an actor, from a client that sends one message, or as a node that answers.

The medium is a posipaki port channel (`socketChannel` from `posipaki/port/node`). Everything the protocol needs above
it is written here.

## Run it

The Erlang side, on a machine that can reach yours:

```
erlc robot.erl
POSIPAKI_NODE=posipaki@192.168.88.27 \
  erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
```

`robot.erl` hosts three names: `robot` answers `<<"hello ", Text>>`, `echo` answers `<<"echo: ", Text>>`, and `relay` is the
round trip below. `robot:watch()` is the other direction, run from a node of its own — see below. The node runs with
`-name` rather than `-sname`: a short-name node refuses to connect to a name whose host is an address, and this side is
addressed by one.

Then, from here:

```
$ bun demo/client.ts 192.168.88.20 --cookie pocookie --to echo --message "through the proxy"
echo: through the proxy
```

Options: the host is the one positional; `--cookie` (`~/.erlang.cookie` unless given), `--node` (the node's name in epmd,
`robot`), `--to` (the name to send to on it, the node's own name unless another is given), `--self` (the node name this
side claims, `posipaki@<host>`), `--message` (what to send, `robot`).

## An actor that stands for a process over there

`makeErlangRef({ node, process })` is one: an `ETF_RAW` in-message is a term sent to that process, and the actor ends when
it does. `makeErlangConnect()` is the same with the address in the fork's args, and `makeErlangFactory({ node, module,
fname })` starts a function there, with the fork's args as its parameters.

```
const node = await startNode({ self: "probe@192.168.88.27", cookie, register: false });
const peer = await makeErlangRef({ node: nodeRef("robot", "192.168.88.20"), process: "echo" }).spawn(undefined);
await peer.send({ type: "ETF_RAW", body: tuple(processTerm(aProcessOfOurs), binary(text)) });
```

The term carries the address of whoever should hear the answer, and the node routes it: `pidOf(process)` mints the pid
once, and minting is what serves it. A name is a separate table — `registerProcess(name, process)` is what a `{6}`
resolves against — and `processOf(pid)` names the process a pid belongs to in the incarnation running now.

## Being watched

A monitor is a subscription to a process's end, and the other side can hold one on a process this node serves. Nothing
asks for that watch: the demo's process answers `whois` with the pid it answers at, so a peer with the node's name and the
cookie does the rest itself.

```
$ bun demo/node.ts --name posipaki@192.168.88.27 --cookie pocookie
posipaki@192.168.88.27 listening on 0.0.0.0:46002
posipaki@192.168.88.27 serves posipaki and stays up; ^C stops it
  asked: {#remote<watcher5@192.168.88.20.10>, whois}
  asked: exit
  exit: this process ends, and a peer watching it is told why
```

```
tomato$ POSIPAKI_NODE=posipaki@192.168.88.27 erl -name watcher@192.168.88.20 -setcookie pocookie \
              -noshell -eval 'robot:watch(), halt().'
watching posipaki at 'posipaki@192.168.88.27' (#Ref<0.4252275418.591396869.210899>)
whois posipaki: <10603.1.0> (#Ref<0.4252275418.591396869.210955>)
asking <10603.1.0> to exit
down #Ref<0.4252275418.591396869.210899> {posipaki,'posipaki@192.168.88.27'} normal
down #Ref<0.4252275418.591396869.210955> <10603.1.0> normal
```

The answer carries the address the watcher used: a watch on a pid is answered with the pid, a watch on a name with the
name. A name is resolved here, once, when the watch arrives — `noproc` at once if nothing serves it — and the answer goes
back over the connection the watch came in on.

`node.close()` lets those answers go before the connection closes: a peer watching a process is owed the reason it ended,
and `noconnection` is a different fact. The same wire the other way: `node.watch(pid)` and `node.watchName(ref, name)`
settle with the reason — `normal`, an error, `noproc` for an address that serves nobody, `noconnection` when the peer
goes. An `ErlangProcess` in a term has `wait()`, `monitor()`, `kill()` and `link(process)`.

Measured against tomato: a watch on a name nobody serves answers `noproc` at once, and a watch on a live one stays open.

## Starting a process over there

`node.spawn(ref, {module, function, args})` asks a node to run `module:function(args)` and answers an `ErlangProcess` for
the process it started — the same handle a pid in a term gives, so `send`, `monitor`, `kill` and `wait` work on it.

```
const started = await node.spawn(nodeRef("robot", "192.168.88.20"), {
  module: "timer",
  function: "sleep",
  args: [integer(200)],
});
console.log(started.address.kind);       // pid: what the wire writes, and what a term carries
console.log(show(await started.wait()));   // normal
```

Erlang's vocabulary, not this side's: a module and a function name what runs. A module that is not there is not
refused — the process starts and dies with `undef`, and a watch set after that answers `noproc`.

## Both directions, and a round trip

Two nodes of this host, a mapper of their own, and the Erlang node in the middle. Node 1 says hi to tomato's `relay`;
tomato answers node 1, then hands the *same* message to `posipaki` on node 3; node 3 answers node 1's pid directly —
which needs a connection node 3 opens, and a pid it has never seen the node of.

```
# node 3: serves a process named `posipaki`, and answers whatever is addressed to it
bun demo/node.ts --name posipaki@192.168.88.27 --port 46002 --cookie pocookie
# node 1: serves a process named `probe`, says hi to `relay` on tomato, and hears both answers
bun demo/node.ts --name probe@192.168.88.27 --port 46001 --cookie pocookie \
    --say relay --node robot2@192.168.88.20
```

A host needs a mapper for a node here to be found by name: the first node started with `epmd: { start: "auto" }` runs one,
and `bun src/mapper-cli.ts` is the copy that outlives it. Tomato's `relay` asks *this* host's mapper where `posipaki` is,
which is the connection node 3 accepts; and node 1 is reached by a pid, so nothing looks it up.

The run below used `robot2@192.168.88.20`: a node of the name started above was already running on that host, and nothing
in the flow turns on the name of the node in the middle.

The two logs, in order:

```
node 1:  said hi to relay on robot2@192.168.88.20
node 1:    asked: tomato: hi
node 1:    and nothing here answers it
node 3:    asked: {#remote<probe@192.168.88.27.1>, hi}
node 1:    asked: {hi, #remote<posipaki@192.168.88.27.1>, answering}
node 1:    and nothing here answers it
```

Node 3 answered `{#remote<probe@…>, hi}` over a connection it opened itself. Node 1 heard that answer as a `DOP_SEND`,
which carries no sender, so the term's own pid is the only way back — which is why the answerer reads the address out of
the term rather than from a field.

A node is a handle, not a process: `startNode({ self, cookie, host, port })` listens, registers the name with the mapper
at its own host, and `registerProcess(name, process)` gives it an ordinary actor to answer with. The port is the OS's to
pick: a mapper is what makes a node findable, and a node whose port must be known is one nobody can look up.

## The layers

Bottom up, one file each, each with its own tests:

- `frame.ts` — bytes as packets: the length a packet announces, two bytes until the handshake ends and four after.
  An empty packet is a tick, answered and not handed up.
- `terms.ts` — the external term format, read and written: integers, atoms, binaries, tuples, lists, maps, pids. A
  reference is read as the octets it arrived as and written back the same way: its id is the peer's, not this side's.
- `control.ts` — what a distribution message's control tuple says: `{2, '', To}`, `{6, From, '', ToName}`,
  `{3, From, To, Reason}`, the three a watch is made of (`{19, …}`, `{20, …}`, `{21, …}`), and any other opcode named as
  such rather than skipped.
- `messages.ts` — what a frame says: a status, a node's name, a challenge, a reply, an ack, or a message. `'N'` is the
  one tag the octets do not tell apart, so the reading takes the side it is for.
- `handshake.ts` — both roles, `initiate` and `accept`, and the point where the wire widens.
- `epmd.ts` — the port mapper at both ends: where a node listens, and the mapper on this host that nodes register with.
- `connection.ts`, `listen.ts` — the two roles of a connection, each proving the cookie before handing over a channel.
- `cluster.ts` — where nodes are found, and the grammar of a node's name: `makeCluster` installs one under its name,
  `clusterNamed` answers the one a node is bound to, and a `NodeRef` is a node in a cluster, its name and host.
- `processes.ts` — processes in a term: what a caller writes, and what it is handed back. An `ErlangProcess` is a pid
  with `send`, `monitor`, `kill`, `link` and `wait`; an `ErlangNamedProcess` is a name on a node with `send` and
  `monitor`.
- `node.ts` — this side as a node, both directions: what it is, the listener, the registration and the tables that route
  what a peer sends, and the connections, pids, watches, starts and RPCs this side makes to a peer. A served process is an
  ordinary actor: `ETF_RAW {body}` in, `{to, body}` out.
- `actor.ts` — a process on another node as an actor here: one body, three makers for where the address comes from.
- `demo/` — `client.ts` sends one term and prints the answer, `node.ts` serves a process that answers and, asked, watches
  or says hi, `answerer.ts` is that process, and `args.ts`/`settings.ts` are the small parts they share.
- `src/mapper-cli.ts` — the mapper as a program (`posipaki-epmd-mapper`, or `bun src/mapper-cli.ts`). A node with
  `epmd: { start: "auto" }` runs the same `serveEpmd` inside itself; this is the copy that outlives it.

`bun test` in this directory runs every layer's tests: memory channels for the framing and the meaning, real sockets for
the connections, and a real node on a port of its own for what a node serves.

## What it does not do

- No atom cache in the distribution header and no fragments, so every message is a pass-through byte and a plain term,
  the way `ei` sends them.
- Links exist between a peer and the processes this node serves, and nowhere else: `node.link(process, pid)` joins one,
  an incoming exit ends the served process unless the reason is `normal`, and an end here is sent to every link. Two
  actors of this side cannot link to each other — the runtime has parent and child, not peers.
- The reason a watch answers is `normal` for an end the process was asked for, and `{error, Message}` for one it died of.
  The stack is not carried.
- A name is only a name where this side registers one: `node.registerProcess` decides what it means, and a name nothing holds is
  complained about once and dropped, as erts drops one.
- A spawn request is answered by a node that runs BEAM code, and a node of this side does not answer one: `node.spawn`
  starts an Erlang function, and starting a definition of this side at a peer waits on a registry. A peer that reports an
  error to the group leader of a process started here sends a term this side may not read — a bignum, so far — and that
  frame is complained about and dropped while the connection carries on.
- Ticks are answered but not started.
- Distribution is not encrypted. The cookie authenticates; it does not protect the traffic.

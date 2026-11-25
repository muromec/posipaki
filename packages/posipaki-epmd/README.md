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

`robot.erl` hosts four names: `robot` answers `<<"hello ", Text>>`, `echo` answers `<<"echo: ", Text>>`, `relay` is the
round trip below, and `watcher` watches a process of this side and prints what each watch answers. The node runs with
`-name` rather than `-sname`: a short-name node refuses to connect to a name whose host is an address, and this side is
addressed by one.

Then, from here:

```
$ bun demo/client.ts 192.168.88.20 pocookie --to echo --message "through the proxy"
robot@192.168.88.20 as echo, our pid 1
echo: through the proxy
```

Options: `--node` (the node's name in epmd, `robot`), `--to` (the name to send to on it, the node's own name unless
another is given), `--self` (the node name this side claims, `posipaki@<host>`), `--message` (what to send, `robot`).

## A proxy actor

`ErlangProxy` stands for a registered process on that node: `{node: NodeRef, processName}`, `ETF_RAW` in
and out, the body being a BEAM term. What goes in becomes a `DOP_REG_SEND` to that name; what the node sends to the
proxy's pid comes back out.

```
const cluster = installCluster(makeCluster({ self: "probe@192.168.88.27", cookie, creation }));
const proxy = await ErlangProxy.spawn({ node: nodeRef("robot", "192.168.88.20"), processName: "echo" });
await proxy.send({ type: "ETF_RAW", body: tuple(proxy.state.erlangPid, binary(text)) });
```

The pid it answers at is published on the process: `state.erlangPid`. It is minted from the process's own identity,
never reused, and `cluster.pidOf(process)` answers the same one however often it is asked; `cluster.processOf(pid)`
names the process a pid belongs to, in the incarnation this runtime is running now — a pid from an earlier one names
nobody.

## Being watched

A monitor is a subscription to a process's end, and the other side can hold one on a process of this node. `watcher` on
the Erlang node watches the process this side serves — by its pid, and by the name it is served under — tells it
`<<"exit">>`, and prints the two answers:

```
$ bun demo/monitored.ts 192.168.88.20 pocookie --self posipaki@192.168.88.27 --to watcher
posipaki@192.168.88.27 listening on 36577, serving posipaki
asked watcher on robot@192.168.88.20 to watch #PID<posipaki@192.168.88.27.1.0> and posipaki
  heard exit
exit requested
```

```
robot@192.168.88.20:  watching <11102.1.0> (#Ref<0.3255852011.3336568838.91841>) and posipaki at
                      'posipaki@192.168.88.27' (#Ref<0.3255852011.3336568838.91842>)
                      down #Ref<0.3255852011.3336568838.91841> <11102.1.0> normal
                      down #Ref<0.3255852011.3336568838.91842> {posipaki,'posipaki@192.168.88.27'} normal
```

The answer carries the address the watcher used: a watch on a pid is answered with the pid, a watch on a name with the
name. A name is resolved here, once, when the watch arrives — `noproc` at once if nothing serves it — and the answer
goes back over the connection the watch came in on.

`node.close()` lets those answers go before the connection closes. A peer watching a process is owed the reason it
ended, and `noconnection` is a different fact.

## Both directions, and a round trip

Two nodes of this host, a mapper of their own, and the Erlang node in the middle. Node 1 says hi to tomato's `relay`;
tomato answers node 1, then hands the *same* message to node 3; node 3 answers node 1's pid directly — which needs a
connection node 3 opens, and a pid it has never seen the node of.

```
# on this host, with `bun src/mapper-cli.ts` answering "where does a node listen" at :4369
bun demo/node.ts --name posipaki@192.168.88.27 --port 46002        # node 3: answers, and accepts
bun demo/node.ts --name probe@192.168.88.27 --port 46001 \
    --say robot@192.168.88.20 --to relay                           # node 1: says hi, and accepts
```

The node is a handle, not a process: `cluster.node()` listens and registers with the mapper at the node's own host, and
`node.serve(name, process)` gives it an ordinary actor to answer with. Its port is the OS's to pick: a mapper is what
makes a node findable, and a node whose port must be known is one nobody can look up.

```
const node = await cluster.node({ port: 46002 });   // a fixed port, for a host with no mapper at all
node.serve("posipaki", answerer);
```

A host that already runs a mapper — a real epmd, or `posipaki-epmd-mapper` — is the default: a node registers with it and
fails its start when none answers. `epmd: { start: "auto" }` on the cluster runs one inside the node instead, for a host
with nothing else on it. Only one mapper can hold a port, so a second one loses the bind and reads that as the first
one answering.

The two logs, in order:

```
probe@…:      saying "hi" to relay on robot@192.168.88.20
posipaki@…:   asked by #remote<robot@192.168.88.20.91>: {#remote<probe@192.168.88.27.1>, hi}
probe@…:      asked by nobody the wire named: tomato: hi
probe@…:      and nothing to answer: the term names no process
probe@…:      asked by nobody the wire named: {#remote<posipaki@192.168.88.27.1>, answering, done}
probe@…:      and nothing to answer: only a hi is answered
```

Node 3 answered `{#remote<probe@…>, hi}` over a connection it opened itself. Node 1 heard that answer as a `DOP_SEND`,
which carries no sender, so the term's own pid is the only way back — which is why the answerer reads the address out of
the term rather than from a field.

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
- `cluster.ts` — the nodes one identity can reach: discovery, one connection per node, and the pids this side answers
  at. A `NodeRef` names a cluster and a node in it; nothing in it is a connection.
- `proxy.ts` — a registered process on a node as an actor here.
- `node.ts` — this side as a node: a listener, a registration, and the two tables that route what a peer sends. A served
  process is an ordinary actor: `ETF_RAW {from?, body}` in, `{to, body}` out.
- `index.ts` — the exports; nothing in it decides anything.
- `demo/` — `client.ts`, `node.ts`, `monitored.ts`, and the argument parsing `client.ts` uses.
- `src/mapper-cli.ts` — the mapper as a program (`posipaki-epmd-mapper`, or `bun src/mapper-cli.ts`). A node with
  `epmd: { start: "auto" }` runs the same `serveEpmd` inside itself; this is the copy that outlives it.

`bun test` in this directory runs every layer's tests: memory channels for the framing and the meaning, real sockets for
the connections, and a real node on a port of its own for what a node serves.

## What it does not do

- No atom cache in the distribution header and no fragments, so every message is a pass-through byte and a plain term,
  the way `ei` sends them.
- No links, and no `EXIT` back to a peer: one side can watch the other, and neither can be killed by it. A crash is not
  told apart from a clean end yet — it arrives on the process's error path, and what goes on the wire is `normal`.
- A name is only a name where this side serves one: `node.serve` decides what it means, and a name nothing serves is
  complained about once and dropped, as erts drops one.
- Ticks are answered but not started.
- Distribution is not encrypted. The cookie authenticates; it does not protect the traffic.

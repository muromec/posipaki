# posipaki-epmd

Talk to an Erlang node over its own distribution protocol: ask epmd where a node listens, prove a cookie, and exchange
BEAM terms with it — from an actor, or from a client that sends one message.

The medium is a posipaki port channel (`socketChannel` from `posipaki/port/node`). Everything the protocol needs above
it is written here.

## Run it

The Erlang side, on a machine that can reach yours:

```
erlc robot.erl
POSIPAKI_NODE=posipaki@192.168.88.27 \
  erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
```

`robot.erl` hosts three names: `robot` answers `<<"hello ", Text>>`, `echo` answers `<<"echo: ", Text>>`, and `relay`
is the round trip below. The node runs with `-name` rather than `-sname`: a short-name node refuses to connect to a
name whose host is an address, and this side is addressed by one.

Then, from here:

```
$ bun demo/client.ts 192.168.88.20 pocookie --to echo --message "through the proxy"
robot@192.168.88.20 as echo, our pid 1
echo: through the proxy
```

Options: `--node` (the node's name in epmd, `robot`), `--to` (the name to send to on it, the node's own name unless
another is given), `--self` (the node name this side claims, `posipaki@<host>`), `--message` (what to send, `robot`).

## A proxy actor

`ErlangProxy` stands for a registered process on that node: `{node: NodeRef, processName}`, state `null`, `ETF_RAW` in
and out, the body being a BEAM term. What goes in becomes a `DOP_REG_SEND` to that name; what the node sends to the
proxy's pid comes back out.

```
const cluster = installCluster(makeCluster({ self: "probe@192.168.88.27", cookie, creation }));
const ref = nodeRef("robot", "192.168.88.20", cluster.name);
const proxy = await ErlangProxy.spawn({ node: ref, processName: "echo" });
await proxy.send({ type: "ETF_RAW", body: { kind: "tuple", items: [cluster.address(ref), text] } });
```

Two decisions worth knowing. A reference is a *name* — a cluster and a node in it — so the connection is looked up and
opened in `setup`, not in the actor's arguments. And one reference is one pid: `cluster.address(ref)` answers the same
pid every time, which is what lets a caller put "me" in a message a node will answer, while two references are two
pids on one shared connection.

## Both directions, and a round trip

Two nodes of this host, a mapper of their own, and the Erlang node in the middle. Node 1 says hi to tomato's `relay`;
tomato answers node 1, then hands the *same* message to node 3; node 3 answers node 1's pid directly — which needs a
connection node 3 opens, and a pid it has never seen the node of.

```
# on this host
bun demo/mapper.ts                                                 # answers "where does a node listen" at :4369
bun demo/node.ts --name posipaki@192.168.88.27 --port 46002        # node 3: answers, and accepts
bun demo/node.ts --name probe@192.168.88.27 --port 46001 \
    --say robot@192.168.88.20 --to relay                           # node 1: says hi, and accepts
```

The two logs, in order:

```
probe@…:   saying "hi" to relay on robot@192.168.88.20
posipaki@…: robot@192.168.88.20 connected        # tomato found us through our mapper and opened this
posipaki@…:   regSend: {#PID<probe@192.168.88.27.1.0>, hi}
posipaki@…:   answering probe@192.168.88.27 directly
probe@…:   robot@192.168.88.20 send: tomato: hi   # tomato's own answer, on the connection node 1 opened
probe@…: posipaki@192.168.88.27 connected         # node 3 opening a connection of its own
probe@…:   posipaki@192.168.88.27 send: posipaki@192.168.88.27 heard hi
```

## The layers

Bottom up, one file each, each with its own tests:

- `frame.ts` — bytes as packets: the length a packet announces, two bytes until the handshake ends and four after.
  An empty packet is a tick, answered and not handed up.
- `terms.ts` — the external term format, read and written: integers, atoms, binaries, tuples, lists, maps, pids.
- `control.ts` — what a distribution message's control tuple says: `{2, '', To}`, `{6, From, '', ToName}`,
  `{3, From, To, Reason}`, and any other opcode named as such rather than skipped.
- `messages.ts` — what a frame says: a status, a node's name, a challenge, a reply, an ack, or a message. `'N'` is the
  one tag the octets do not tell apart, so the reading takes the side it is for.
- `handshake.ts` — both roles, `initiate` and `accept`, and the point where the wire widens.
- `epmd.ts` — the port mapper at both ends: where a node listens, and the mapper on this host that nodes register with.
- `connection.ts`, `listen.ts` — the two roles of a connection, each proving the cookie before handing over a channel.
- `cluster.ts` — the nodes one identity can reach: discovery, one connection per node, and the pids this side answers
  at. A `NodeRef` names a cluster and a node in it; nothing in it is a connection.
- `proxy.ts` — a registered process on a node as an actor here.
- `index.ts` — the exports; nothing in it decides anything.
- `demo/` — `client.ts`, `node.ts`, `mapper.ts`, and the command-line parser they share.

`bun test` in this directory runs every layer's tests: memory channels for the framing and the meaning, real sockets
for the connections, with only the node itself faked.

## What it does not do

- No atom cache in the distribution header and no fragments, so every message is a pass-through byte and a plain term,
  the way `ei` sends them.
- No monitors, no links, no `EXIT` back to a peer, and no process registry on this side: a name in a `DOP_REG_SEND` is
  handed up as the name it carried, so what a name means is the caller's.
- Ticks are answered but not started.
- Distribution is not encrypted. The cookie authenticates; it does not protect the traffic.

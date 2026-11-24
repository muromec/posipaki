# posipaki-epmd

A proof that a process outside the BEAM can speak Erlang's own distribution protocol: it asks epmd for a node's
port, does the handshake with a cookie, sends one message to a registered name, and prints the answer.

The medium is a posipaki port channel (`socketChannel` from `posipaki/port/node`). Everything the protocol needs
above it is written here.

## Run it

The Erlang side, on a machine that can reach yours:

```
erlc robot.erl
erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
```

`robot.erl` registers two processes on the node: `robot` answers `<<"hello ", Text>>` and `echo` answers
`<<"echo: ", Text>>`, each echoing what it was sent. So a run shows both facts at once — which name it reached, and
that the text it sent is the text that came back.

Then:

```
$ bun src/index.ts 192.168.88.20 pocookie
robot@tomato at 192.168.88.20:44257
hello robot

$ bun src/index.ts 192.168.88.20 pocookie --to echo --message ping
robot@tomato at 192.168.88.20:44257
echo: ping
```

Options: `--node` (the node's name in epmd, `robot`), `--to` (the name to send to on it, the node's own name unless
another is given), `--self` (the node name this side claims, `posipaki@<host>`), `--message` (what to send, `robot`).
`POSIPAKI_EPMD_TRACE=1` prints what this side sends and receives.


## Both directions, and a round trip

Two nodes of this host, a mapper of their own, and the Erlang node in the middle. Node 1 says hi to tomato's `relay`;
tomato answers node 1, then hands the *same* message to node 3; node 3 answers node 1's pid directly — which needs a
connection node 3 opens, and a pid it has never seen the node of.

```
# on this host
bun src/mapper.ts                                                 # answers "where does a node listen" at :4369
bun src/node.ts --name posipaki@192.168.88.27 --port 46002       # node 3: answers, and accepts
bun src/node.ts --name probe@192.168.88.27 --port 46001 \
    --say robot@192.168.88.20 --to relay                          # node 1: says hi, and accepts

# on tomato
erlc robot.erl
POSIPAKI_NODE=posipaki@192.168.88.27 \
  erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
```

What the two logs say, in order:

```
probe@…:   saying "hi" to relay on robot@192.168.88.20
posipaki@…: robot@192.168.88.20 connected        # tomato found us through our mapper and opened this
posipaki@…:   regSend: {#PID<probe@192.168.88.27.1.0>, hi}
posipaki@…:   answering probe@192.168.88.27 directly
probe@…:   robot@192.168.88.20 send: tomato: hi   # tomato's own answer, on the connection node 1 opened
probe@…: posipaki@192.168.88.27 connected         # node 3 opening a connection of its own
probe@…:   posipaki@192.168.88.27 send: posipaki@192.168.88.27 heard hi
```

Four legs: ours out, theirs back, theirs in, ours back — and each direction is a connection the receiving side made.

## The layers

Bottom up, one file each, each with its own tests:
- `frame.ts` — bytes as packets: the length a packet announces, two bytes until the handshake ends and four after.
  `use(4)` is how the wire widens, a frame longer than its width can announce is refused where it is sent, and an
  empty packet is a tick that is answered and not handed up.
- `terms.ts` — the external term format, read and written: integers, atoms, binaries, tuples, lists, maps, pids.
- `control.ts` — what a distribution message's control tuple says: `{2, '', To}` a message for a process,
  `{6, From, '', ToName}` one for a registered name, `{3, From, To, Reason}` the node closing the connection, and
  any other opcode named as such rather than skipped.
- `messages.ts` — what a frame says: a status, a node's name, a challenge, a reply, an ack, or a distribution
  message of a control and the term after it. `'N'` is the one tag the octets do not tell apart, so the reading takes
  the side it is for — the side that opened the connection reads a challenge, the side that answered reads a name.
- `handshake.ts` — both roles: `initiate` and `accept`, each proving the cookie by hashing the other's challenge, and
  each the point where the wire widens, because the ack is the last two-byte message.
- `epmd.ts` — the port mapper, both ends: where a node listens (its answer carries no length and ends when it closes
  the socket), and the mapper on this host that nodes register with and ask.
- `connection.ts` — the composition for the side that opens: epmd's port, the socket, frames, messages, handshake.
- `listen.ts` — the composition for the side that answers: a socket arrives, the handshake proves the cookie, and the
  channel is the caller's.
- `network.ts` — reaching a pid: a node not yet reached is looked up in the mapper at its host and connected, which is
- `proxy.ts` — a registered process on a node, as an actor here: `ETF_RAW` in goes to that name as a `DOP_REG_SEND`,
  and what the node sends to the proxy's pid comes back out as `ETF_RAW`. One proxy, one pid; a term this side cannot
  write is complained about, not fatal.
  how an answer to somebody else's pid arrives.
- `args.ts`, `index.ts` — the command line, and the one-message client.
- `mapper.ts`, `node.ts` — the two programs of the round trip: a mapper for this host, and a node that both accepts
  connections and reaches out.

`bun test` in this directory runs the tests of every layer over memory channels; nothing but the medium is faked.

## What it does not do

- No atom cache in the distribution header and no fragments, so every message is a pass-through byte and a plain
  term, the way `ei` sends them.
- No monitors, no links, no `EXIT` back to a peer, and no process registry: a name in a `DOP_REG_SEND` is handed up as
  the name it carried, so what a name means is the caller's. A message to a name nobody answers is dropped by the
  node, and this side waits until its bound runs out.
- Ticks are answered but not started: a connection this side holds open with nobody talking on it stays alive because
  the other end ticks, and a peer that never does will see it go quiet.
- Distribution is not encrypted. The cookie authenticates; it does not protect the traffic.

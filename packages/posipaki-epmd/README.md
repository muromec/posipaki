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

`robot.erl` registers a process called `robot` that answers every `{From, _}` with the binary `<<"hello robot">>`.

Then:

```
bun src/index.ts <host> <cookie>
```

```
$ bun src/index.ts 192.168.88.20 pocookie
robot@tomato at 192.168.88.20:46257
hello robot
```

Options: `--name` (the registered name, `robot`), `--self` (this side's node name, `posipaki@<host>`),
`--message` (what to send, `robot`). `POSIPAKI_EPMD_TRACE=1` prints what this side sends and receives.

## The layers

Bottom up, one file each, each with its own tests:

- `frame.ts` — bytes as packets: the length a packet announces, two bytes until the handshake ends and four after.
  `use(4)` is how the wire widens, and the framing is where a frame longer than its width can announce is refused.
- `terms.ts` — the external term format, read and written: integers, atoms, binaries, tuples, lists, maps, pids.
- `messages.ts` — what a frame says: a status, a node's name, a challenge, a reply, an ack, or a distribution
  message of a control and the term after it. `'N'` is the one tag the octets do not tell apart, so this module is
  a client's reading, and `decodeName` is the other.
- `handshake.ts` — the cookie, proved by both sides hashing the other's challenge, and the point where the wire
- `control.ts` — what a distribution message's control tuple says: `{2, '', To}` a message for a process,
  `{6, From, '', ToName}` one for a registered name, `{3, From, To, Reason}` the node closing the connection, and
  any other opcode named as such rather than skipped.
  widens: the ack is the last two-byte message.
- `epmd.ts` — where the node listens. Its answer carries no length field at all and ends when epmd closes the
  socket, so it is read to the close instead of being cut into frames.
- `index.ts` — the entry: the names, the flags this client offers, one message, the answer printed.

`bun test` in this directory runs the tests of every layer over memory channels; nothing but the medium is faked.

## What it does not do

- It is a client only. Nothing here accepts a connection, so the script is not yet a node other nodes can reach.
- No atom cache in the distribution header and no fragments, so every message is a pass-through byte and a plain
  term, the way `ei` sends them.
- No monitors, links, exit signals or ticks. A message to a name that is not registered is dropped by the node,
  and the script waits until its bound runs out.
- Distribution is not encrypted. The cookie authenticates; it does not protect the traffic.

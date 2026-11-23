# posipaki-epmd

A proof that a process outside the BEAM can speak Erlang's own distribution
protocol: it asks epmd for a node's port, does the handshake with a cookie, and
sends one message to a registered name. The answer is printed.

One script, `src/index.ts`. The socket is a posipaki port channel
(`socketChannel` from `posipaki/port/node`); the framing, the handshake and the
term format are the script's own, over `Channel<Uint8Array>`.

## Run it

The Erlang side, on a machine that can reach yours:

```
erlc robot.erl
erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
```

`robot.erl` registers a process called `robot` that answers every
`{From, _}` with the binary `<<"hello robot">>`.

Then:

```
bun src/index.ts <host> <cookie>
```

```
$ bun src/index.ts 192.168.88.20 pocookie
robot@tomato at 192.168.88.20:46257
hello robot
```

Options: `--name` (the registered name, `robot`), `--self` (this side's node
name, `posipaki@<host>`), `--message` (what to send, `robot`).
`POSIPAKI_EPMD_TRACE=1` prints every packet read and written, in hex.

## What it does

- `EPMD_PORT2_REQ` to the port mapper on the node's host, to learn its
  distribution port. The reply has no length prefix: epmd closes the socket
  when it has said its piece.
- The version-6 handshake: `'N'` with the mandatory flags, a challenge, and
  md5(cookie + challenge) proved in both directions. A wrong cookie is not a
  message from the node: erts drops the connection instead.
- One `{DOP_REG_SEND, FromPid, Cookie, ToName}` carrying `{OurPid, Text}`.

## What it does not do

- It is a client only. Nothing here accepts a connection, so the script is not
  yet a node other nodes can reach.
- No atom cache in the distribution header and no fragments, so every message
  is a pass-through byte and a plain term, the way `ei` sends them.
- No monitors, links, exit signals or ticks. A message to a name that is not
  registered is dropped by the node, and the script waits until its timeout.
- Distribution is not encrypted. The cookie authenticates; it does not protect
  the traffic. Erlang's TLS distribution is a separate arrangement.

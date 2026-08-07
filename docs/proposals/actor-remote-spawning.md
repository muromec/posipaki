# Actor Process Isolation & Context Mobility

**Status:** draft

## Motivation

All actors (router, openai, terminal bridge, transports) currently run inside a
single Node.js process. The actor architecture already uses message-passing
between actors — but those messages stay in-process.

The real primitive isn't process isolation — it's **context mobility**: the
ability to run a posipaki actor in any execution context that can speak a
simple wire protocol. That context could be a child process, a bubblewrap
sandbox, a different machine over SSH, or even an Erlang node.

Push that boundary: spawn actors across contexts, with messages serialised
over a pipe. From the consumer's perspective, nothing changes — messages in,
messages out. The boundary is invisible.

---

## Architecture

### Layered design

```
┌──────────────────────────────────────┐
│  Protocol semantics                   │
│  $proto, $init, $state, $msg,        │
│  $exit, $fd                          │
├──────────────────────────────────────┤
│  Encoding                             │
│  ndjson.v1 | msgpack.v1 | ...        │
├──────────────────────────────────────┤
│  Transport                            │
│  fifo | ssh+relay | tcp | ...        │
└──────────────────────────────────────┘
```

Each layer is a pluggable interface. The protocol semantics don't change when
the encoding or transport does.

### Separation of concerns

| Layer | Owns |
|-------|------|
| **Wire protocol** | Six message types, handshake, sender identity, fd forwarding |
| **Bridge adapter** | spawn + transport + protocol — the universal primitive |
| **Isolation wrappers** | `withBwrap`, `withSudo`, `withSsh` — modify the spawn command |
| **Supervisor** | restart on crash, backoff, exit-code semantics |
| **Actor** | unchanged — same handlers, state, doesn't know it's remote |

The bridge spawns, bridges messages, and resolves when the child exits. The
supervisor is a separate wrapper. Isolation wrappers are pure functions on the
spawn command.

---

## API

### One file, both ends

The wrapper module serves as both the host-side import and the child-side
entry point. One file per actor type:

```ts
// src/actors/openai/reflector-remote.ts
import { defineRemoteActor } from 'posipaki/remote';
import { MyActor } from './my-actor.js';

export const myRemoteActor = defineRemoteActor(
  MyActor.fn, import.meta.url,
);
```

`defineRemoteActor` receives `import.meta.url` and compares it to
`process.argv[1]` internally.  If they match, it runs the child bridge
(`runChild()`).  Otherwise it returns the remote actor for import.
The spawn command auto-derives as `node <this-file>`.

### Consumer API

From the consumer's perspective, the remote actor has the **same shape** as
the original. Spawn it the same way:

```ts
// In-process (current):
const proc = Reflector.spawn(null)({ tools, history, persona: 'butler' });

// Remote — same call, same return type:
import { myRemoteActor } from './reflector-remote';
const proc = myRemoteActor.spawn(null)({ tools, history, persona: 'butler' });

// Both give you:
await proc.ready();
proc.send({ type: 'IN_MESSAGE', ... });
proc.state;
await proc.wait();
```

The proxy implements the full posipaki process interface. The router doesn't
know which it got — local or remote is an implementation detail.

### Wrappers compose at the call site

Isolation wrappers are functions from spawnable → spawnable. The base module
exposes metadata (command path, name), and the consumer wraps as needed:

```ts
import { myRemoteActor } from './reflector-remote';
import { withBwrap, withSudo } from 'posipaki/remote';

const isolated = withSudo('butler',
  withBwrap({ roBind: ['data/butler', '/data'] },
    myRemoteActor
  )
);

const proc = isolated.spawn(null)(args);
```

Each wrapper intercepts `spawn()` to modify the command. They compose freely.
No variant entry point files needed — wrapping is done at the call site.

### Wrapper types

```ts
type Spawnable<Args, State, InMsg, OutMsg> = {
  spawn(ctx: ProcessCtx | null): (args: Args) => Promise<RemoteProxy<State, InMsg, OutMsg>>;
  runChild(): Promise<void>;
  meta: {
    command: string[];   // base command (e.g. ['node', 'this-file.ts'])
    name: string;        // actor name
  };
};

type Wrapper = (inner: Spawnable) => Spawnable;

function withSudo(user: string): Wrapper;
function withBwrap(opts: BwrapOptions): Wrapper;
function withSsh(host: string): Wrapper;
```

`defineRemoteActor` creates the innermost `Spawnable`. Wrappers wrap it
outward. The final `.spawn()` tunnels through the chain.

---

## Wire Protocol

### Transport

The child process **always** uses a named fifo for the wire protocol. Never
stdin/stdout. This guarantees stdout is free for logging and `console.log`
from dependencies can never corrupt the wire.

```
node dist/child.js --fifo /tmp/actor-<name>-<id>.pipe --name <name>
```

The host creates the fifo, passes the path to the child, and opens the other
end. For local and bwrap, the host reads the fifo directly. For SSH, a relay
process on the remote machine bridges the fifo to the SSH transport (see
below).

### Protocol versioning

The first line on the wire declares the protocol version. The child writes it
immediately on connect:

```
child → host:  {"$proto":"ndjson.v1"}
```

The version line lets the host select a parser. `ndjson.v1` means
"newline-delimited JSON, semantic version 1." A future `msgpack.v1` would
trigger a different deserializer. The protocol *semantics* stay the same
across encodings.

The version is signaled through the pipe, not as a CLI flag — the CLI is
owned by the spawn command (which could be `ssh`, `sudo`, `bwrap`). The host
adapter doesn't control the child's argv beyond the base command.

### Message types

Six message types at the wire level:

#### `$proto` (child → host)

Protocol version negotiation. Sent once, immediately on connect.

```json
{"$proto":"ndjson.v1"}
```

#### `$init` (host → child)

Start arguments. Sent after version handshake.

```json
{"$init":{"tools":["..."],"history":["..."],"persona":"butler"}}
```

The child responds by emitting its initial `$state` — that's the "ready"
signal.

#### `$state` (child → host)

Reactive state updates. The first `$state` after `$init` is the initial state.
Subsequent `$state` messages carry deltas or full snapshots whenever the
actor's state changes:

```json
{"$state":{"status":"ready"}}
{"$state":{"turns":5,"mood":"focused"}}
```

The host proxy accumulates the latest state and exposes it as `proxy.state`.

#### `$msg` (bidirectional)

A posipaki message crossing the boundary. Carries the message body plus sender
identity:

```json
{"$msg":{
  "type":"IN_MESSAGE",
  "fromName":"root",
  "fromIdName":"root",
  "body":{"content":{"tag":"body","body":"hello"}}
}}
```

The receiving adapter reconstitutes `[body, { fromName, fromId:
Symbol.for(fromIdName) }]` and dispatches to the actor.

**Symbol handling:** Symbols that aren't `Symbol.for` can't round-trip. The
`fromIdName` field is absent for those, and the receiving side synthesizes a
fresh symbol. This is a known shortcoming of the JSON encoding — a future
binary encoding could carry symbols natively.

#### `$exit` (child → host)

Child announces graceful exit. Carries exit code and final state snapshot:

```json
{"$exit":{"code":0,"state":{"tired":true,"turns":42}}}
```

Best-effort — SIGKILL means no exit message. The host must handle both cases:
graceful `$exit` on the wire, and sudden pipe close.

#### `$fd` (child → host)

Captured stdout/stderr output from the child process:

```json
{"$fd":{"fd":"stdout","data":"processing...\n"}}
{"$fd":{"fd":"stderr","data":"[warn] deprecation notice\n"}}
```

The child adapter captures fd 1 and fd 2 at startup, wraps output as `$fd`
messages, and sends them over the wire alongside everything else. The host
adapter receives them and forwards to its own stdout/stderr.

This means a single channel carries everything: actor messages, state updates,
and debug output. No separate log files or stderr channels needed. Works the
same for local, bwrap, sudo, and SSH.

### Exit handling

| Scenario | What the host sees |
|----------|-------------------|
| `process.exit(0)` | `$exit` message, then pipe closes |
| `process.exit(42)` | `$exit` message with code 42, then pipe closes |
| Crash (SIGSEGV) | Pipe closes, no `$exit` message |
| SIGKILL | Pipe closes, no `$exit` message |

The host adapter resolves `proc.wait()` with `{ code, finalState }`:
- Graceful: code and state from `$exit`
- Crash: code is null, state is last known `$state`

The supervisor (layer above bridge) interprets exit codes:
- 0 = clean exit, do not restart
- 42 = self-requested restart, resolve pending tool call
- null/other = crash, restart with backoff

---

## Transports

### FifoTransport (local, sudo, bwrap)

Host creates a named fifo, spawns the child with `--fifo <path>`, and opens
the fifo for read/write. The fifo carries all six message types.

For sudo: the host creates the fifo, chowns it to the target user, then
spawns `sudo -u <user> node child.js --fifo <path>`.

For bwrap: the host creates the fifo outside the sandbox, adds
`--bind <fifo> <fifo>` to the bwrap args, and spawns
`bwrap ... --bind /tmp/pipe /tmp/pipe -- node child.js --fifo /tmp/pipe`.

### SshTransport (remote machine)

SSH can't directly open a remote fifo. Instead, a **relay process** on the
remote machine bridges the child's fifo to the SSH transport:

```
Host                          SSH session              Remote machine
────                          ───────────              ─────────────

relay stdin  ←── wire ───→  ssh stdout  ←── wire ───→  relay stdout
relay stdout ──→ wire ───→  ssh stdin   ──→ wire ───→  relay stdin
relay stderr ──→ logs ───→  ssh stderr

                              relay:
                                1. mkfifo /tmp/pipe
                                2. spawn node child.js --fifo /tmp/pipe
                                   (child stdout/stderr captured)
                                3. bridge: ssh stdin/stdout ↔ fifo
                                4. forward child stdout/stderr as $fd messages
```

The relay is a thin shim — it could be the child adapter itself with a
`--relay` flag, or a small shell wrapper. The host spawns the relay via SSH,
and the relay handles the rest.

### Future transports

The transport interface is designed for extension:

```ts
interface WireTransport {
  onMessage: (msg: WireMessage) => void;
  onClose: (code: number | null) => void;
  send(msg: WireMessage): void;
  close(): void;
}
```

`TcpTransport` for direct socket connections, `UdpTransport` with checksums
for unreliable networks — all slot in under the same protocol semantics.

---

## Encoding

The encoding is a pluggable layer beneath the protocol:

```ts
interface WireCodec {
  readonly version: string;          // "ndjson.v1"
  encode(msg: WireMessage): Buffer;
  decode(chunk: Buffer): WireMessage[];
}
```

NDJSON is the first implementation. Switching to MessagePack means
implementing this interface and changing the version string. The protocol
semantics don't change.

### Future encodings

A binary encoding could carry things JSON can't:
- **Transferrable buffers** — shared memory for zero-copy data transfer
- **File handles** — `sendmsg`/`recvmsg` with `SCM_RIGHTS`
- **Symbols** — dedicated wire type, no `Symbol.for` round-trip needed

These are v2+ concerns. NDJSON v1 is sufficient for the initial implementation.

---

## Child Adapter

`runChild()` — the child-side implementation called from the CLI entry point:

1. Parse `--fifo <path>`, `--name <name>` from argv
2. Capture stdout/stderr (redirect JS streams, keep raw fd references for `$fd`)
3. Open fifo transport
4. Write `{"$proto":"ndjson.v1"}`
5. Read `$init` → extract actor arguments
6. Spawn the real actor with those arguments
7. Bridge:
   - wire read → `actor.send(msg, sender)`
   - actor emit → wire write (`$msg`, `$state`)
   - captured stdout/stderr → wire write (`$fd`)
8. On actor exit: write `$exit` with code + final state, close transport

The actor itself doesn't know it's remote. Its handlers see normal `[msg,
sender]` tuples. The adapter translates between wire protocol and posipaki
dispatch.

**Sender reconstruction:** `fromIdName` in `$msg` becomes
`Symbol.for(fromIdName)` on the receiving side. If absent (non-`Symbol.for`
symbol was sent), a fresh symbol is synthesized.

## Host Adapter

`spawn(ctx)(args)` — the host-side implementation:

1. Apply wrappers to build the final command
2. Create transport (fifo or SSH relay, depending on wrapper chain)
3. Spawn child process, open transport
4. Read `$proto`, validate version
5. Send `$init` with args
6. Wait for first `$state` → resolve `ready()`
7. Return `RemoteProxy`:
   - `ready()` — already resolved
   - `send(msg)` — wrap as `$msg`, write to transport
   - `state` — latest `$state` from child
   - `wait()` — resolves on `$exit` or pipe close
   - `onMessage(handler)` — called for each incoming `$msg`

## Self-Restart

The agent gets a tool that triggers a restart of its own process:

```
tool_call: restart_self(reason: string)
  → child calls process.exit(42)
  → supervisor sees exit code 42
  → supervisor spawns new child with restart context
  → new child loads conversation history from disk
  → tool result: { status: "restarted", reason: "..." }
```

The `$init` message carries a `restart` flag so the new process knows it's a
continuation, not a fresh start. It resolves the pending `restart_self` tool
call immediately on startup.

### What survives the restart

- **Conversation history** — already on disk (ThreadStore), loaded on init
- **Memory** — already file-backed key-value store
- **Identity** — loaded from identity.yaml

---

## Implementation Order

1. **Wire protocol spec** — this document, finalized
2. **`defineRemoteActor` + `runChild`** — child-side adapter, tested with a
   trivial echo actor over fifo
3. **`spawn()` + `RemoteProxy`** — host-side adapter, tested against echo actor
4. **`$fd` forwarding** — captured stdout/stderr over the wire
5. **Wrappers** — `withBwrap`, `withSudo`, `withSsh` (relay)
6. **Terminal bridge** — first real actor isolated (highest crash risk)
7. **Tool pool** — clean TOOL_CALL/TOOL_RESULT interface
8. **Full persona isolation** — each reflector tree in its own process
9. **Supervisor** — restart policy, backoff, exit-code interpretation
10. **Self-restart tool** — `process.exit(42)` + supervisor coordination

---

## Open Questions

1. **Serialisation audit.** Do any inter-actor messages carry functions or
   non-serializable values? Must verify all messages are pure JSON before
   putting them over a pipe.

2. **Startup latency.** Spawning a Node.js process per actor adds overhead.
   Keep frequently-used actors warm, isolate only the ones that benefit.

3. **State transfer on restart.** Currently the child reloads from disk. Could
   the supervisor pass a snapshot to the new child, avoiding disk I/O? v1:
   disk reload.

4. **Graceful shutdown.** Should the supervisor send STOP and wait for the
   child to finish in-flight work, or SIGTERM immediately? STOP first, SIGTERM
   after timeout.

5. **Cross-process tool calls.** If the tool pool is a separate process, tool
   calls cross a process boundary twice (connector → pool → connector). Extra
   serialization overhead. Measure before optimizing.

6. **SSH relay.** How thin can the relay be? Could it be the child adapter
   itself with a `--relay` flag, or does it need to be a separate process?

---

## Related

- [Per-Process Isolation](per-process-isolation.md) — builds on this with
  per-persona bwrap sandboxes
- [Server Isolation](server-isolation.md) — orthogonal: whole harness in bwrap
- [Docs index](00-INDEX.md)

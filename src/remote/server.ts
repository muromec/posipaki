// ── Server side of the seam ────────────────────────────────────────────────
//
// serveRemoteActor serves a posipaki actor over a frame Channel produced by a
// spawner. It knows only the frame vocabulary (channel.ts) — no protocol, no
// transport, no spawner. The spawner has already done the $proto handshake.

import type { ActorDefinition, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";
import { ProcessTable, encodeProcessRefs } from "./process-ref.js";
import {
  REFLECT_METHODS,
  REFLECT_RESULT,
  asReflectionCall,
  decodeFrame,
  encodeFrame,
  frameTo,
  isInit,
  isMsg,
  jsonProblem,
  type ReflectionCall,
} from "./channel.js";

export type Spawner = () => Promise<Channel>;

export function makeSender(
  fromName: string,
  parentName: string | null,
  parentId: symbol | null,
): { fromName: string; fromId: symbol } {
  if (parentId && fromName === parentName) {
    return { fromName, fromId: parentId };
  }
  return { fromName, fromId: Symbol() };
}

export async function serveRemoteActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  R extends ReflectionOptions,
>(actor: ActorDefinition<Args, State, InMsg, OutMsg, R>, spawner: Spawner): Promise<void> {
  const channel = await spawner();

  // await $init
  const initFrame = decodeFrame(
    await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    }),
  );
  channel.removeHandler();
  if (!isInit(initFrame)) {
    throw new Error("serveRemoteActor: expected $init");
  }

  const init = initFrame.$init;
  const parentName = (init.parentName as string) ?? null;
  const parentIdName = (init.parentIdName as string) ?? null;
  const parentId = parentIdName ? Symbol.for(parentIdName) : null;
  const { parentName: _pn, parentIdName: _pid, ...initArgs } = init;

  const proc = await actor.spawn(initArgs as unknown as Args, {
    name: "remote",
    parentName,
    parentId,
  });

  // This side's own end of the connection is the process it just spawned: id 0
  // here, and on the other side the proxy that asked for it.  Everything else
  // this side hands over is numbered as it goes, and the table is where a frame
  // that arrives with an id — or leaves with a process in it — is resolved.
  const table = new ProcessTable<typeof proc>();
  table.bindRoot(proc);
  /** Every frame that leaves this side: processes become references first. */
  const sendFrame = (frame: Record<string, unknown>) => channel.send(encodeFrame(frame, table));

  // bridge actor output → channel
  const stopMirroringMessage = proc.subscribe("message", async (msg, sender) => {
    try {
      // The root's own emissions, which is what this side's root is.  A message
      // from another process on this side is that process's, and would say so.
      await sendFrame({ $msg: { fromName: sender.fromName, body: msg } });
    } catch {
      console.error("Error sending out the message");
    }
  });
  const stopMirroringState = proc.subscribe("state", async () => {
    try {
      await sendFrame({ $state: proc.state as Record<string, unknown> });
    } catch (e) {
      console.error("Error sending out the message", e);
    }
  });

  await proc.ready();

  // What this actor can be asked over the wire, announced once before the first
  // $state.  The client installs its call side from this list, and a name that
  // was never announced is never dispatched: the list is the whole surface, so
  // no frame can reach a property the actor did not offer.
  const reflection = proc.$reflection as unknown as Record<string, Function>;
  const announced = Object.keys(reflection).filter((name) => typeof reflection[name] === "function");
  await sendFrame({ [REFLECT_METHODS]: announced });
  await sendFrame({ $state: proc.state as Record<string, unknown> });

  /** Call one announced reflection method and answer with what it said, or why not. */
  async function answerCall(call: ReflectionCall, target: typeof proc | undefined): Promise<void> {
    const reply = (body: Record<string, unknown>) =>
      sendFrame({ [`${REFLECT_RESULT}${call.name}`]: body });
    if (!target) {
      await reply({ seq: call.seq, error: "no process with that id on this connection" });
      return;
    }
    // Only what a process announced can be reached.  The root announced its own
    // methods before its first $state; a process that crossed later has not
    // announced anything yet, so there is nothing to dispatch against.
    const methods = target === proc ? announced : [];
    const surface = target.$reflection as unknown as Record<string, Function>;
    const method = methods.includes(call.name) ? surface[call.name] : undefined;
    if (typeof method !== "function") {
      await reply({ seq: call.seq, error: `no reflection method named ${call.name}` });
      return;
    }
    try {
      // A method may be written for a call that answers later; the wire has no
      // opinion about that, it just waits for the frame.
      // References in the arguments become processes this side cannot reach —
      // the id is there, resolving it is not yet — and processes in the answer
      // become references.  What is left has to be JSON, or the call is refused
      // rather than half-written.
      const value = encodeProcessRefs(await method(...call.args), table);
      const problem = jsonProblem(value);
      if (problem !== null) {
        await reply({
          seq: call.seq,
          error: `${call.name} returned ${problem}, which cannot cross a frame`,
        });
        return;
      }
      await reply({ seq: call.seq, value });
    } catch (err) {
      await reply({ seq: call.seq, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // bridge channel input → actor
  channel.onMessage((raw) => {
    const frame = decodeFrame(raw);
    const to = frameTo(frame);
    const target = to === null ? undefined : table.processFor(to);
    if (isMsg(frame)) {
      if (!target) return;
      const { fromName, body } = frame.$msg;
      target.send(body as InMsg, makeSender(fromName, parentName, parentId));
      return;
    }
    const call = asReflectionCall(frame);
    if (call) void answerCall(call, target);
  });

  // await actor exit, announce it, close
  let code = 0;
  try {
    await proc.wait();
  } catch (err) {
    console.error("server actor error:", err);
    code = 1;
  }
  // Stop mirroring before saying goodbye: an actor that settles its state on the
  // way out would otherwise try to write to a wire that is already closed.
  stopMirroringMessage();
  stopMirroringState();
  await sendFrame({ $exit: { code, state: proc.state } });
  await channel.close();
}

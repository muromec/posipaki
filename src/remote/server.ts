// ── Server side of the seam ────────────────────────────────────────────────
//
// serveRemoteActor serves a posipaki actor over a frame Channel produced by a
// spawner. It knows only the frame vocabulary (channel.ts) — no protocol, no
// transport, no spawner. The spawner has already done the $proto handshake.

import type { ActorDefinition, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";
import { ProcessHandles, decodeProcessRefs, encodeProcessRefs } from "./process-ref.js";
import {
  REFLECT_METHODS,
  REFLECT_RESULT,
  asReflectionCall,
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
  const initFrame = await new Promise<Record<string, unknown>>((resolve) => {
    channel.onMessage((frame) => resolve(frame));
  });
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

  // bridge actor output → channel
  const stopMirroringMessage = proc.subscribe("message", async (msg, sender) => {
    try {
      await channel.send({ $msg: { fromName: sender.fromName, body: msg } });
    } catch {
      console.error("Error sending out the message");
    }
  });
  const stopMirroringState = proc.subscribe("state", async () => {
    try {
      await channel.send({ $state: proc.state as Record<string, unknown> });
    } catch (e) {
      console.error("Error sending out the message", e);
    }
  });

  await proc.ready();

  // What this actor can be asked over the wire, announced once before the first
  // $state.  The client installs its call side from this list, and a name that
  // was never announced is never dispatched: the list is the whole surface, so
  // no frame can reach a property the actor did not offer.
  // What this connection uses for the processes it hands over. One table per
  // connection, because an id means nothing on any other one.
  const handles = new ProcessHandles();
  const reflection = proc.$reflection as unknown as Record<string, Function>;
  const announced = Object.keys(reflection).filter((name) => typeof reflection[name] === "function");
  await channel.send({ [REFLECT_METHODS]: announced });
  await channel.send({ $state: proc.state as Record<string, unknown> });

  /** Call one announced reflection method and answer with what it said, or why not. */
  async function answerCall(call: ReflectionCall): Promise<void> {
    const reply = (body: Record<string, unknown>) =>
      channel.send({ [`${REFLECT_RESULT}${call.name}`]: body });
    const method = announced.includes(call.name) ? reflection[call.name] : undefined;
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
      const args = decodeProcessRefs(call.args) as unknown[];
      const value = encodeProcessRefs(await method(...args), handles);
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
  channel.onMessage((frame) => {
    if (isMsg(frame)) {
      const { fromName, body } = frame.$msg;
      proc.send(body as InMsg, makeSender(fromName, parentName, parentId));
      return;
    }
    const call = asReflectionCall(frame);
    if (call) void answerCall(call);
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
  await channel.send({ $exit: { code, state: proc.state } });
  await channel.close();
}

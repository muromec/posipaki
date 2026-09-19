// ── Server side of the seam ────────────────────────────────────────────────
//
// serveRemoteActor serves a posipaki actor over a frame Channel produced by a
// spawner. It knows only the frame vocabulary (channel.ts) — no protocol, no
// transport, no spawner. The spawner has already done the $proto handshake.

import type { ActorDefinition, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import { isProcess } from "../process.async.js";
import type { Channel } from "./channel.js";
import {
  ProcessTable,
  ROOT_ID,
  encodeProcessRefs,
  isRemoteProcess,
  type ProcessHandle,
  type ProcessRef,
} from "./process-ref.js";
import { RemoteProcess, type FrameSink } from "./remote-process.js";
import { ProcessStreams, reflectionNames } from "./process-streams.js";
import { makeSender } from "./sender.js";
import {
  REFLECT_METHODS,
  REFLECT_RESULT,
  asReflectionCall,
  decodeFrame,
  encodeFrame,
  frameTo,
  isExit,
  isInit,
  isMsg,
  isPause,
  isRelease,
  isResume,
  isState,
  isStop,
  jsonProblem,
  type ReflectionCall,
} from "./channel.js";

export type Spawner = () => Promise<Channel>;

/** The name the served actor is spawned under, and the one it answers to as a
 *  sender when it talks to a process of the far side's. */
const ROOT_NAME = "remote";

export async function serveRemoteActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  R extends ReflectionOptions,
>(actor: ActorDefinition<Args, State, InMsg, OutMsg, R>, spawner: Spawner): Promise<void> {
  const channel = await spawner();

  // The table takes the even ids: the odd ones are the far side's, so the same
  // number can never name a process on both ends at once.  A process that is
  // numbered here is one that is about to cross, and its stream follows the frame
  // that carried it.
  const table = new ProcessTable<ProcessHandle>("even", (proc, id) => streams.crossed(proc, id));

  const sendToFrame = async (frame: Record<string, unknown>, to: number): Promise<void> => {
    await channel.send(encodeFrame(frame, table, to));
    streams.flush();
  };

  const sendTo: FrameSink = (frame, to) => {
    void sendToFrame(frame, to).catch((e: unknown) => {
      console.error("Error sending out the frame", e);
    });
  };

  // Everything is in place to speak: the sink writes to the wire, and what the
  // table numbers crosses through it.
  const streams = new ProcessStreams(sendTo);

  /** The handle for a reference that arrived: the same one every time, and the
   *  process itself when the reference names a process of this side's own. */
  const handleFor = (ref: ProcessRef): ProcessHandle => {
    const held = table.processFor(ref.id);
    if (held) return held;
    const known = table.farHandleFor(ref.id);
    if (isRemoteProcess(known)) return known;
    const handle = new RemoteProcess(ref, sendTo, ROOT_NAME, (id) => table.release(id));
    // The far side's root is not bound: that process is id 0, and this side's own
    // end of the connection is already the one holding it.
    if (ref.id !== ROOT_ID) table.bindFar(ref.id, handle);
    return handle;
  };

  // await $init
  const initFrame = decodeFrame(
    await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    }),
    handleFor,
  );
  channel.removeHandler();
  if (!isInit(initFrame)) {
    throw new Error("serveRemoteActor: expected $init");
  }
  // A frame that arrives while the actor is still starting has nothing to be
  // dispatched to yet, and the channel has one handler slot: it waits here
  // rather than being dropped, and is replayed below.
  const waiting: Record<string, unknown>[] = [];
  channel.onMessage((frame) => waiting.push(frame));

  const init = initFrame.$init;
  const parentName = (init.parentName as string) ?? null;
  const parentIdName = (init.parentIdName as string) ?? null;
  const parentId = parentIdName ? Symbol.for(parentIdName) : null;
  const { parentName: _pn, parentIdName: _pid, ...initArgs } = init;

  const proc = await actor.spawn(initArgs as unknown as Args, {
    name: ROOT_NAME,
    parentName,
    parentId,
  });

  // This side's own end of the connection is the process it just spawned: id 0
  // here, and on the other side the proxy that asked for it.
  table.bindRoot(proc);

  // bridge actor output → channel
  const stopMirroringMessage = proc.subscribe("message", async (msg, sender) => {
    // The root's own emissions, which are the root's: a message from another
    // process of this side's is that process's, and its stream says so.
    sendTo({ $msg: { fromName: sender.fromName, body: msg } }, ROOT_ID);
  });
  const stopMirroringState = proc.subscribe("state", async () => {
    sendTo({ $state: proc.state as Record<string, unknown> }, ROOT_ID);
  });

  await proc.ready();

  // What this actor can be asked over the wire, announced once before the first
  // $state.  The client installs its call side from this list, and a name that
  // was never announced is never dispatched: the list is the whole surface, so
  // no frame can reach a property the actor did not offer.
  await sendToFrame({ [REFLECT_METHODS]: reflectionNames(proc) }, ROOT_ID);
  await sendToFrame({ $state: proc.state as Record<string, unknown> }, ROOT_ID);

  /** Call one announced reflection method and answer with what it said, or why not. */
  async function answerCall(call: ReflectionCall, target: ProcessHandle | undefined): Promise<void> {
    const reply = (body: Record<string, unknown>) =>
      sendToFrame({ [`${REFLECT_RESULT}${call.name}`]: body }, ROOT_ID);
    // Only a process this side holds can be asked: the id a call names is the
    // holder's own, and this side is the holder of what it serves.
    if (!isProcess(target)) {
      await reply({ seq: call.seq, error: "no process with that id on this connection" });
      return;
    }
    const names = reflectionNames(target);
    const surface = target.$reflection as unknown as Record<string, Function>;
    const method = names.includes(call.name) ? surface[call.name] : undefined;
    if (typeof method !== "function") {
      await reply({ seq: call.seq, error: `no reflection method named ${call.name}` });
      return;
    }
    try {
      // A method may be written for a call that answers later; the wire has no
      // opinion about that, it just waits for the frame.
      // References in the arguments become handles on the far side's processes,
      // and processes in the answer become references.  What is left has to be
      // JSON, or the call is refused rather than half-written.
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
  function dispatch(raw: Record<string, unknown>): void {
    const frame = decodeFrame(raw, handleFor);
    const to = frameTo(frame);
    const target = to === null ? undefined : table.resolve(to);
    if (isRelease(frame)) {
      // A process of this side's own, let go of over there: nothing more is said
      // about it, and the id the far side knew it by is no longer this
      // connection's.  The process itself is untouched — it runs on, and a later
      // crossing numbers it afresh.
      if (to !== null) {
        streams.stop(to);
        table.release(to);
      }
      return;
    }
    if (isState(frame)) {
      // A process the far side holds, saying what it holds: that is news for the
      // handle on it, and lands where a subscription can see it.  A state frame
      // about a process of this side's own is this side's to publish, not the
      // far side's to tell it.
      if (isRemoteProcess(target)) target.receiveState(frame.$state);
      return;
    }
    if (isExit(frame)) {
      // A process the far side holds, gone.  Nothing more will be said about it,
      // so this is the last thing a handle can be told.
      if (isRemoteProcess(target)) target.receiveExit(frame.$exit);
      return;
    }
    if (isStop(frame) || isPause(frame) || isResume(frame)) {
      // Control, addressed to the process it is about: acted on by whoever holds
      // that process, which is this side.
      if (isProcess(target)) {
        const sender = makeSender(ROOT_NAME, parentName, parentId);
        if (isStop(frame)) void target.stop({ from: sender });
        else if (isPause(frame)) target.pause();
        else target.resume();
      }
      return;
    }
    if (isMsg(frame)) {
      const { fromName, body } = frame.$msg;
      // A message for a process this side holds goes into it.  One about a
      // process the far side holds — a handle here — is that process talking,
      // and goes to whoever subscribed to the handle.
      if (isProcess(target)) target.send(body as InMsg, makeSender(fromName, parentName, parentId));
      else if (isRemoteProcess(target)) target.receiveMessage(body as OutMsg, fromName);
      return;
    }
    const call = asReflectionCall(frame);
    if (call) void answerCall(call, target);
  }

  channel.removeHandler();
  channel.onMessage(dispatch);
  for (const frame of waiting.splice(0)) dispatch(frame);

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
  streams.stopAll();
  await sendToFrame({ $exit: { code, state: proc.state } }, ROOT_ID);
  await channel.close();
}

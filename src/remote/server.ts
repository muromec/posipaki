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
  SERVED_ROOT_NAME,
  isRemoteProcess,
  type ProcessHandle,
  type ProcessRef,
} from "./process-ref.js";
import { RemoteProcess, type FrameSink } from "./remote-process.js";
import { ProcessStreams } from "./process-streams.js";
import { makeSender } from "./sender.js";
import {
  REFLECT_METHODS,
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
  isTune,
  isReflectionMethods,
  tuneFrame,
} from "./channel.js";
import { CallSide, answerCall } from "./call-side.js";

export type Spawner = () => Promise<Channel>;

/** The name the served actor is spawned under, and the one it answers to as a sender when
 *  it talks to a process of the far side's: what the client states in `$init`, since the
 *  process being served is the one its proxy was forked as over there.  The fallback is for
 *  a connection that states none — an older client, or a hand-written `$init` — where the
 *  far side's name for its own end is all there is to go on. */
let rootName: string = SERVED_ROOT_NAME;

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

  /** Put an encoded frame on the wire, and then say what it numbered.  A frame that
   *  carried a reference has to be out before anything about that process is. */
  const write = async (frame: Record<string, unknown>): Promise<void> => {
    await channel.send(frame);
    streams.flush();
  };

  const sendToFrame = (frame: Record<string, unknown>, to: number): Promise<void> =>
    write(encodeFrame(frame, table, to));

  /** Every frame leaves this way.  The answer is handed back, since the one frame that
   *  has to be out before the wire closes is awaited by the side that owns the wire. */
  const sendTo: FrameSink = (frame, to) =>
    sendToFrame(frame, to).catch((e: unknown) => {
      console.error("Error sending out the frame", e);
    });

  // Everything is in place to speak: the sink writes to the wire, and what the
  // table numbers crosses through it.
  const streams = new ProcessStreams(sendTo, table.rootId());

  // Both ends of a connection make calls and answer them: a process the far side
  // holds is asked the same way this side is asked.
  const calls = new CallSide(write, table);

  /** The handle for a reference that arrived: the same one every time, and the process
   *  itself when the reference names a process of this side's own.  The roots are
   *  numbered apart, so a reference to the far side's root is a reference to a process
   *  of theirs, and a handle like any of those. */
  const handleFor = (ref: ProcessRef): ProcessHandle => {
    const held = table.processFor(ref.id);
    if (held) return held;
    const known = table.farHandleFor(ref.id);
    if (isRemoteProcess(known)) return known;
    const handle = new RemoteProcess(ref, sendTo, rootName, (id) => table.release(id));
    table.bindFar(ref.id, handle);
    return handle;
  };

  // await $init, keeping everything that arrives with it.  The channel has one handler
  // slot, and a frame that arrives while the actor is still starting has nothing to be
  // dispatched to yet, so the frames wait here and are replayed below.  The $init is the
  // first of them, that being what the connection is made by.
  const waiting: Record<string, unknown>[] = [];
  await new Promise<void>((resolve) => {
    channel.onMessage((frame) => {
      waiting.push(frame);
      resolve();
    });
  });
  channel.removeHandler();
  const initFrame = decodeFrame(waiting.shift() as Record<string, unknown>, handleFor);
  if (!isInit(initFrame)) {
    throw new Error("serveRemoteActor: expected $init");
  }

  const init = initFrame.$init;
  const stated = init.rootName;
  if (typeof stated === "string" && stated !== "") rootName = stated;
  const parentName = (init.parentName as string) ?? null;
  const parentIdName = (init.parentIdName as string) ?? null;
  const parentId = parentIdName ? Symbol.for(parentIdName) : null;
  const { parentName: _pn, parentIdName: _pid, ...initArgs } = init;

  const proc = await actor.spawn(initArgs as unknown as Args, {
    name: rootName,
    parentName,
    parentId,
  });

  // This side's own end of the connection is the process it just spawned: id 0
  // here, and on the other side the proxy that asked for it.
  table.bindRoot(proc);

  await proc.ready();

  // The root is a process that crossed this connection like any other, at the id this
  // side gave it.  What it can be asked is announced, and what it holds and what it
  // says are said once the far side asks: the announced list is the whole surface, so a
  // name that was never on it can never be reached.  A proxy on the other end asks for
  // the state and the messages it stands in for the moment it connects.
  streams.crossed(proc, table.rootId());
  streams.flush();

  // bridge channel input → actor
  function dispatch(raw: Record<string, unknown>): void {
    const frame = decodeFrame(raw, handleFor);
    // An answer is about the call waiting for it and not about a process: it names
    // the seq, and is settled before anything is looked up.
    if (calls.settle(frame)) return;
    const to = frameTo(frame);
    if (to === null) return;
    // A frame answers one of two questions.  News about a process the far side holds
    // lands on the handle for it: what it holds, that it is over, what it can answer.
    // An ask of a process this side holds goes to wherever that process lives: a
    // message, control, a call, a tune.
    const news = table.farHandleFor(to);
    const mine = table.processFor(to);
    if (isRelease(frame)) {
      // A process of this side's own, let go of over there: nothing more is said about
      // it, and the id the far side knew it by is no longer this connection's.  The
      // process itself runs on, and a later crossing numbers it afresh.  Neither root is
      // let go of, so the table refuses both.
      if (mine !== undefined) {
        streams.stop(to);
        table.release(to);
      }
      return;
    }
    if (isTune(frame)) {
      // How much the far side is told about a process of this side's own is that
      // side's to ask, and this is where the asking lands: what it names is what
      // crosses from now on.  An id this side does not hold has nothing to tune.
      if (mine !== undefined) {
        const kinds = tuneFrame(frame);
        if (kinds !== null) streams.tune(to, kinds);
      }
      return;
    }
    if (isReflectionMethods(frame)) {
      // What a process the far side holds can answer, said the moment it crossed:
      // the handle here reads it as its own surface, so a name asked on it is asked
      // there.  What a process of this side's own can answer is this side's to
      // announce, not the far side's to tell it.
      if (isRemoteProcess(news)) {
        news.receiveMethods(frame[REFLECT_METHODS], (method, args) => calls.call(method, args, to));
      }
      return;
    }
    if (isState(frame)) {
      // A process the far side holds, saying what it holds: that is news for the
      // handle on it, and lands where a subscription can see it.  A state frame about
      // a process of this side's own is this side's to publish, not the far side's to
      // tell it.
      if (isRemoteProcess(news)) news.receiveState(frame.$state);
      return;
    }
    if (isExit(frame)) {
      // A process the far side holds, gone.  Nothing more will be said about it, so
      // this is the last thing a handle can be told.
      if (isRemoteProcess(news)) news.receiveExit(frame.$exit);
      return;
    }
    if (isStop(frame) || isPause(frame) || isResume(frame)) {
      // Control, addressed to the process it is about: acted on by whoever holds that
      // process, which is this side.  The root is one of those — stopping it stops
      // what the connection is for — and a handle has nothing here to act on.
      if (isProcess(mine)) {
        const sender = makeSender(rootName, parentName, parentId);
        if (isStop(frame)) void mine.stop({ from: sender });
        else if (isPause(frame)) mine.pause();
        else mine.resume();
      }
      return;
    }
    if (isMsg(frame)) {
      const { fromName, body } = frame.$msg;
      // A message for a process this side holds goes into it, the root included.  One
      // about a process the far side holds — a handle here — is that process talking,
      // and goes to whoever subscribed to the handle.
      if (isProcess(mine)) mine.send(body as InMsg, makeSender(fromName, parentName, parentId));
      else if (isRemoteProcess(news)) news.receiveMessage(body as OutMsg, fromName);
      return;
    }
    const call = asReflectionCall(frame);
    if (call) void answerCall(call, mine, write, table);
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
  // The root is over, which is the last thing said about it.  It is said and awaited
  // here, because the wire closes right after it.
  await streams.sayEnded(table.rootId(), code);
  // And nothing more about anything else of this side's: there is no one left to say
  // it to.
  streams.stopAll();
  // A call this side made and the far side has not answered is not going to be
  // answered now; it fails here rather than hanging.
  calls.rejectAll();
  await channel.close();
}

// ── Server side of the seam ────────────────────────────────────────────────
//
// serveChannel serves one process over a frame Channel that is already through the `$proto` handshake, and
// takes a factory for the process rather than spawning one itself. It knows only the frame vocabulary
// (channel.ts) — no protocol, no transport, no spawner. The reactor calls it once for each connection it
// accepts, and serveRemoteActor (reactor.ts) is the same thing for a single connection.
import type { ActorDefinition, SpawnedFrom } from "../actor-types.js";
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
  badReason,
  decodeFrame,
  encodeFrame,
  errorFrame,
  errorReason,
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

/** The process a definition's spawn gives back: what a caller reports when it serves one. */
export type ServedProcess<T extends ActorDefinition<any, any, any, any, any>> = SpawnedFrom<T>;

/** A process, whatever definition it came from: all the serving half needs of one. */
export type AnyProcess = ServedProcess<ActorDefinition<any, any, any, any, any>>;

/** What the far side stated when it opened the connection: the args it asks to be spawned with, and its own
 *  name for its end of the connection. */
export interface Init<Args = unknown> {
  readonly args: Args;
  /** The name the process answers to as a sender: the far side's word, or the default when it stated none. */
  readonly rootName: string;
  readonly parentName: string | null;
  readonly parentId: symbol | null;
}

/** What a factory answers: the process to serve, and what the serving half has to know about it. */
export interface Served<Meta = unknown> {
  readonly proc: AnyProcess;
  /** What the factory resolved, when it has more to say about the session than the connection did. */
  readonly meta?: Meta;
  /**
   * What ends this session: run once, when the connection closes and when the reactor stops.  It defaults to
   * stopping the process, which is what a factory that spawned one wants; a factory that hands over a process
   * it did not spawn returns its own, since that process outlives every connection.
   */
  readonly cleanup?: () => void | Promise<void>;
}

/** A factory, as the serving half sees it: the connection and the meta are its caller's business. */
export type MakeProcess<Meta = unknown> = (init: Init) => Served<Meta> | Promise<Served<Meta>>;

/** The name the served actor is spawned under, and the one it answers to as a sender when
 *  it talks to a process of the far side's: what the client states in `$init`, since the
 *  process being served is the one its proxy was forked as over there.  The fallback is for
 *  a connection that states none — an older client, or a hand-written `$init` — where the
 *  far side's name for its own end is all there is to go on. */
let rootName: string = SERVED_ROOT_NAME;

export async function serveChannel<Meta = unknown>(
  channel: Channel,
  makeProc: MakeProcess<Meta>,
  /**
   * Called once the served process is up and wired to the connection, with what the factory answered and the
   * one function that ends this session.  Nothing about the serve changes because of it.
   */
  onSpawned?: (served: Served<Meta>, ended: () => Promise<void>) => void,
): Promise<void> {
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

  /** Set once the connection is winding down: from here a frame that cannot be delivered has
   *  nowhere to go by construction, and saying so with a stack is noise (see the sink below). */
  let pvtWindDown = false;

  /** Every frame leaves this way.  The answer is handed back, since the one frame that
   *  has to be out before the wire closes is awaited by the side that owns the wire. */
  const sendTo: FrameSink = (frame, to) =>
    sendToFrame(frame, to).catch((e: unknown) => {
      // Two different things wear the same words.  On a live wire a frame that did not go is a
      // loss and belongs in the log with its stack; during the wind-down the peer is gone by
      // construction and every stream still saying its last word fails the same way.  Measured on
      // the voice service, 2026-09-28: half a dozen raw stacks per restart from the teardown paths
      // alone, which is how a reader — twice that evening — comes to mistake a deploy for an outage.
      if (pvtWindDown) return;
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

  // The first frame is the $init.  A connection that goes before it will never be served, so the wait
  // settles on the close as well: pending forever is one promise and one channel left behind per peer
  // that dials and hangs up.  The collecting handler stays until the actor can be dispatched to, so
  // frames that arrive while it starts wait here and are replayed rather than dropped for want of a slot.
  const waiting: Record<string, unknown>[] = [];
  let stopCollecting: () => void = () => {};
  await new Promise<void>((resolve, reject) => {
    stopCollecting = channel.onMessage((frame) => {
      waiting.push(frame);
      resolve();
    });
    channel.onClose(() => reject(new Error("serveRemoteActor: the connection went before $init")));
  });
  const firstFrame = waiting.shift() as Record<string, unknown>;
  // A first frame that could not be read is a failed start like any other: the far side is told
  // what could not be read, and this connection is refused to its caller — the spawner that opened
  // it — rather than raised into the host.  Nothing is served yet, so nothing is stopped here.
  const initProblem = badReason(firstFrame) ?? errorReason(firstFrame);
  if (initProblem !== null) {
    await write(errorFrame(`expected $init: ${initProblem}`)).catch(() => undefined);
    throw new Error(`serveRemoteActor: expected $init (${initProblem})`);
  }
  const initFrame = decodeFrame(firstFrame, handleFor);
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

  const opening: Init = {
    args: initArgs,
    rootName,
    parentName,
    parentId,
  };
  const served = await makeProc(opening);
  const proc = served.proc;

  // What ends this session, run once: the factory's cleanup when it returned one, and stopping the process
  // when it did not.  A process meant to outlive the connection is handed over with a cleanup of its own,
  // since stopping it here would end it for every other connection bound to it.  The call is kept, so
  // whoever asks second waits for the ending rather than returning before it.
  let pvtEnding: Promise<void> | null = null;
  const end = (): Promise<void> => {
    if (pvtEnding === null) {
      pvtEnding = (async () => {
        await (served.cleanup ?? (() => proc.stop()))();
      })();
    }
    return pvtEnding;
  };

  // This side's own end of the connection is the process this session serves: id 0
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

  // The session is over when either side is: the process ended, or the connection went.  That is the same
  // moment for a process the session owns, since its cleanup stops it, and not the same at all for one that
  // outlives the connection.  A close handler is one slot, so the promise the teardown waits on is settled
  // from the same place the cleanup runs.
  let pvtGone: () => void = () => {};
  const connectionGone = new Promise<void>((resolve) => {
    pvtGone = resolve;
  });
  channel.onClose(() => {
    pvtGone();
    void end();
  });

  // The process is up and wired: whoever asked for the handle of what is served gets it here, which is
  // the only moment it exists and the connection is still open.
  onSpawned?.(served, end);

  /**
   * A frame that was not a frame is the connection's problem and not the process's: the far side is
   * told what could not be read, and then this connection ends — the actor it was serving ends with
   * it, that being what it was spawned for.  The host everything else runs in is never the cost of
   * one peer that is not speaking the protocol.
   *
   * The write is awaited only so the reason is out before the wire closes.  A wire that has already
   * gone ends nothing twice, and the ending is the part that matters.
   */
  const endUnreadable = async (reason: string): Promise<void> => {
    console.warn(`a frame from the far side could not be read: ${reason}`);
    try {
      await write(errorFrame(reason));
    } catch {
      // The wire went before the reason could; the ending below is the same either way.
    }
    await end();
  };

  // bridge channel input → actor
  function dispatch(raw: Record<string, unknown>): void {
    // A frame about the wire is settled before anything else is looked up: what a codec could not
    // read, and a far side saying the connection is over, are one piece of news here — this
    // connection cannot be spoken over any more, and nothing said after it could be trusted.  The
    // connection ends; the process does not.
    const wireProblem = badReason(raw) ?? errorReason(raw);
    if (wireProblem !== null) {
      void endUnreadable(wireProblem);
      return;
    }
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
      if (isProcess(mine)) mine.send(body, makeSender(fromName, parentName, parentId));
      else if (isRemoteProcess(news)) news.receiveMessage(body, fromName);
      return;
    }
    const call = asReflectionCall(frame);
    if (call) void answerCall(call, mine, write, table);
  }

  // The collecting reader stops here, and the dispatch is what hears the frames from now on: the two are
  // not the same reader, and leaving the first one on would buffer every frame for nobody.
  stopCollecting();
  channel.onMessage(dispatch);
  for (const frame of waiting.splice(0)) dispatch(frame);

  // The session is awaited here: the process's end, or the connection going, whichever is first.
  let code = 0;
  const procEnded = proc.wait().then(
    () => undefined,
    (err: unknown) => {
      console.error("server actor error:", err);
      code = 1;
    },
  );
  await Promise.race([procEnded, connectionGone]);
  // Whichever it was, the session's cleanup runs here: the process stops, unless the factory answered with
  // something else to do.
  await end();
  // The root is over, which is the last thing said about it.  It is said and awaited
  // here, because the wire closes right after it.  From this line on, the wire is going: what
  // cannot be delivered is expected, and the sink stops reporting it.
  pvtWindDown = true;
  await streams.sayEnded(table.rootId(), code);
  // And nothing more about anything else of this side's: there is no one left to say
  // it to.
  streams.stopAll();
  // A call this side made and the far side has not answered is not going to be
  // answered now; it fails here rather than hanging.
  calls.rejectAll();
  await channel.close();
}

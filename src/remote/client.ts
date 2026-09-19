// ── Client side of the seam ────────────────────────────────────────────────
//
// remoteClient builds a posipaki actor that talks to a remote server through a
// frame Channel produced by a spawner. It knows only the frame vocabulary
// (channel.ts) — no protocol, no transport, no spawner. The spawner has
// already done the $proto handshake.

import { defineActor } from "../define-actor.js";
import { isProcess } from "../process.async.js";
import { stopPropagation } from "../hooks.js";
import type { HookResult } from "../hooks.js";
import type { ActorDefinition, HandlerOptions, MethodOptions, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";
import {
  ProcessTable,
  SERVED_ROOT_NAME,
  isRemoteProcess,
  type ProcessHandle,
  type ProcessRef,
} from "./process-ref.js";
import { ProcessStreams } from "./process-streams.js";
import { RemoteProcess, type FrameSink } from "./remote-process.js";
import { makeSender } from "./sender.js";
import {
  REFLECT_METHODS,
  asReflectionCall,
  decodeFrame,
  encodeFrame,
  frameTo,
  isExit,
  isMsg,
  isPause,
  isRelease,
  isResume,
  isStop,
  isReflectionMethods,
  isState,
  isTune,
  tuneFrame,
} from "./channel.js";
import { CallSide, answerCall } from "./call-side.js";

export type ClientSpawner<Args> = (args: Args) => Promise<Channel>;


export function remoteClient<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions = MethodOptions,
  Handlers extends HandlerOptions<InMsg> = HandlerOptions<InMsg>,
  R extends ReflectionOptions = ReflectionOptions,
>(
  name: string,
  spawner: ClientSpawner<Args>,
): ActorDefinition<Args, State, InMsg, OutMsg, R> {
  const proxyDef = defineActor<
    Args,
    {
      public: State;
      private: {
        channel: Channel;
        farRoot: RemoteProcess<InMsg, OutMsg>;
        exitPromise: Promise<{ code: number | null; state: State }>;
      };
    },
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    R
  >({
    name,
    handlers: {} as unknown as Handlers,
    async setup(args: Args) {
      // This side's own end of the connection is the root, and id 0 is how both
      // sides name it: the far actor on one end, this proxy on the other.  The
      // table takes the odd ids for the processes this side holds — the far side
      // takes the even ones — so an id says on its own which side holds it.
      // A process this side hands over is numbered by the table, and from then on
      // the far side is told what it says: the stream follows the frame that
      // carried the reference.
      const table = new ProcessTable("odd", (proc, id) => streams.crossed(proc, id));
      const root = this.ctx;
      table.bindRoot(root);
      const channel = await spawner(args);
      const fromName = name;
      // Everything is in place to speak: the sink writes to the wire, and what the
      // table numbers crosses through it.  The sink is reached by a call rather
      // than handed over, because what it does is flush these streams.
      const streams = new ProcessStreams((frame, to) => sendTo(frame, to), table.rootId());

      /** Put an encoded frame on the wire, and then say what it numbered.  A frame that
       *  carried a reference has to be out first, or the far side hears about a process
       *  it cannot name yet. */
      const write = (frame: Record<string, unknown>): Promise<void> =>
        Promise.resolve(channel.send(frame)).then(() => streams.flush());

      /** Every frame leaves this way: the processes in it become references, and
       *  what the frame is addressed to becomes the id the far side knows. */
      const sendTo: FrameSink = (frame, to) => {
        void write(encodeFrame(frame, table, to)).catch((error: unknown) => {
          console.error("Error sending out the frame", error);
        });
      };
      sendTo(
        {
          $init: {
            ...(args as unknown as Record<string, unknown>),
            parentName: fromName,
            parentIdName: fromName,
          },
        },
        table.farRootId(),
      );

      let currentState: Record<string, unknown> = {};

      // ── the call side ──────────────────────────────────────────────────
      // This side both makes calls and answers them, and so does the other end of
      // every connection: what a call is, and how an answer finds the one waiting
      // for it, is written once in call-side.ts.
      const calls = new CallSide(write, table);

      /**
       * The handle for a reference that arrived.  A process handed over twice is one
       * process, so a reference that names one this side already knows gives back the
       * handle it gave last time, and one that names a process of this side's own —
       * handed back to its owner — gives back that process.
       *
       * The roots are numbered apart, so the numbers say what belongs to whom: 1 is this
       * side's own end, and 0 is the far side's root, which is a handle like any of the
       * processes they hold.
       */
      const handleFor = (ref: ProcessRef): ProcessHandle => {
        const held = table.processFor(ref.id);
        if (held) return held;
        const known = table.farHandleFor(ref.id);
        if (isRemoteProcess(known)) return known;
        const handle = new RemoteProcess(ref, sendTo, fromName, (id) => table.release(id));
        table.bindFar(ref.id, handle);
        return handle;
      };

      /**
       * The far side's root, which is what this proxy stands in for.  It is bound here
       * like any other reference the far side sends: what it holds, what it says, when
       * it is over and what it can answer reach it as they reach any handle.
       */
      const farRoot = new RemoteProcess<InMsg, OutMsg>(
        { id: table.farRootId(), pname: SERVED_ROOT_NAME },
        sendTo,
        fromName,
        (id) => table.release(id),
      );
      table.bindFar(table.farRootId(), farRoot);

      // Setup is done when the far side has said what it holds; until then the
      // one handler below is what takes everything that arrives, so nothing
      // falls between two of them.
      let started: (() => void) | null = null;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });

      // All three in one asking, since this proxy stands in for the far root: what it
      // holds is this proxy's state, what it says is what this proxy says, and its end
      // is the end of the connection.  A process says nothing until something asks, and
      // the root is no exception.
      farRoot.tune(["message", "state", "exit"]);
      farRoot.subscribe("state", () => {
        // One object, updated the way the far side publishes it: the proxy's state is
        // the far root's, and a caller here reads it as `proc.state`.
        Object.assign(currentState, farRoot.state ?? {});
        root.notify();
        started?.();
        started = null;
      });
      farRoot.subscribe("message", (msg) => {
        void this.emit(msg as OutMsg);
      });
      const exitPromise: Promise<{ code: number | null; state: State }> = farRoot.wait().then(
        (exit) => ({ code: exit.code, state: exit.state as State }),
        // The wire went before the far root did: what is known here is that it is over,
        // and the state last heard is the last word there is.
        () => ({ code: null, state: currentState as State }),
      );

      channel.onMessage((raw) => {
        const frame = decodeFrame(raw, handleFor);
        // An answer is about the call waiting for it and not about a process: it names
        // the seq, and is settled before anything is looked up.
        if (calls.settle(frame)) return;
        const to = frameTo(frame);
        if (to === null) return;
        // A frame answers one of two questions.  News about a process the far side holds
        // lands on the handle for it: what it holds, what it says, that it is over, what
        // it can answer.  An ask of a process this side holds goes to wherever that
        // process lives: a message, control, a call, a tune.
        const news = table.farHandleFor(to);
        const mine = table.processFor(to);
        if (isRelease(frame)) {
          // A process of this side's own, let go of over there: nothing more is said
          // about it, and the id is no longer this connection's.  The process itself
          // runs on.  Neither root is let go of, so the table refuses both.
          if (mine !== undefined) {
            streams.stop(to);
            table.release(to);
          }
          return;
        }
        if (isReflectionMethods(frame)) {
          // What the far side holds can answer, and how this side asks it: what was
          // announced is the whole surface, so a name never announced is never called
          // here either.  The far root's names go on this proxy's own surface as well,
          // since the proxy is the process a caller here holds.
          if (isRemoteProcess(news)) {
            news.receiveMethods(frame[REFLECT_METHODS], (method, callArgs) =>
              calls.call(method, callArgs, to),
            );
            if (to === table.farRootId()) {
              calls.install(
                this.reflection as unknown as Record<string, unknown>,
                frame[REFLECT_METHODS],
                table.farRootId(),
              );
            }
          }
          return;
        }
        if (isState(frame)) {
          // A process the far side holds, saying what it holds: news for whoever
          // subscribed to the handle.
          if (isRemoteProcess(news)) news.receiveState(frame.$state);
          return;
        }
        if (isExit(frame)) {
          // A process the far side holds, gone: nothing more will be said about it.
          if (isRemoteProcess(news)) news.receiveExit(frame.$exit);
          return;
        }
        if (isMsg(frame)) {
          // A message naming a process this side holds goes into it, the proxy's own
          // root included, and the wire says who sent it by name alone.  One about a
          // process the far side holds is that process talking, and goes to whoever
          // subscribed to the handle.
          if (isProcess(mine)) {
            mine.send(frame.$msg.body as InMsg, makeSender(frame.$msg.fromName, null, null));
          } else if (isRemoteProcess(news)) {
            news.receiveMessage(frame.$msg.body as OutMsg, frame.$msg.fromName);
          }
          return;
        }
        if (isTune(frame)) {
          // How much the far side hears about a process of this side's own is its to
          // ask, and this is where the asking lands.
          if (mine !== undefined) {
            const kinds = tuneFrame(frame);
            if (kinds !== null) streams.tune(to, kinds);
          }
          return;
        }
        if (isStop(frame) || isPause(frame) || isResume(frame)) {
          // Control, addressed to the process it is about, and acted on by whoever holds
          // it, which is this side.  Its own root is one of those.  A handle has nothing
          // here to act on.
          if (isProcess(mine)) {
            if (isStop(frame)) void mine.stop({ from: makeSender(name, null, null) });
            else if (isPause(frame)) mine.pause();
            else mine.resume();
          }
          return;
        }
        // A call into a process of this side's own, made from over there: the method is
        // this side's to run, and the answer goes back by name and seq.
        const call = asReflectionCall(frame);
        if (call) void answerCall(call, mine, write, table);
      });
      channel.onClose(() => {
        // A call that was in flight when the wire went away has no answer
        // coming; it fails here rather than hanging forever.
        calls.rejectAll();
        // Handles live on this connection: with it gone there is nothing to
        // reach, and nothing to wait for either.
        for (const held of table.handles()) {
          if (isRemoteProcess(held)) held.disconnect();
        }
        // And nothing more is said about the processes of this side's own that
        // were handed over: there is no one left to say it to.
        streams.stopAll();
        // A wire that goes before the far root does leaves nothing to wait for: the
        // handles are gone, and the far root's end is the connection's end, which is
        // what `wait()` on it rejects about.
      });

      await start;

      return {
        public: currentState as State,
        private: { channel, farRoot, exitPromise },
      };

    },
    async onMessage(msg: InMsg): Promise<HookResult> {
      const { farRoot } = this.state.private;
      // A message this side sends is for the root: that is the process the proxy stands
      // for, and it is sent the way any handle sends to a process of the far side's.
      if (farRoot.isConnected()) farRoot.send(msg);
      return stopPropagation();
    },
    async onStopRequested() {
      const { channel, farRoot, exitPromise } = this.state.private;
      if (channel) {
        // Asking the far root to stop is asking a process, not sending it a message:
        // the control frame its holder acts on, the one every other handle uses.  Worth
        // asking only while there is something to ask of it — an end that has come, or
        // a wire that has gone, leaves nothing to ask and nothing to wait for.
        if (farRoot.isConnected() && !farRoot.hasEnded()) {
          void farRoot.stop().catch(() => undefined);
        }
        await exitPromise;
      }
      this.agreeToStop();
    },
    async afterEnd() {
      if (this.state.private.channel) {
        await this.state.private.channel.close();
      }
    },
  });

  return proxyDef as unknown as ActorDefinition<Args, State, InMsg, OutMsg, R>;
}

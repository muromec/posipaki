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
import { ProcessTable, ROOT_ID, isRemoteProcess, type ProcessHandle, type ProcessRef } from "./process-ref.js";
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
        sendTo: FrameSink;
        exitPromise: Promise<{ code: number | null; state: State }>;
        fromName: string;
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
      const streams = new ProcessStreams((frame, to) => sendTo(frame, to));

      /** Put an encoded frame on the wire, and then say what it numbered.  A frame
       *  that carried a reference has to be out before anything about that process
       *  is, or the far side is told about a process it cannot name yet. */
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
        ROOT_ID,
      );

      let currentState: Record<string, unknown> = {};

      // ── the call side ──────────────────────────────────────────────────
      // This side both makes calls and answers them, and so does the other end of
      // every connection: what a call is, and how an answer finds the one waiting
      // for it, is written once in call-side.ts.
      const calls = new CallSide(write, table);

      /**
       * The handle for a reference that arrived.  A process handed over twice is
       * one process, so a reference that names one this side already knows gives
       * back the handle it gave last time; one that names a process of this
       * side's own — handed back to its owner — gives back that process.
       */
      const handleFor = (ref: ProcessRef): ProcessHandle => {
        const held = table.processFor(ref.id);
        if (held) return held;
        const known = table.farHandleFor(ref.id);
        if (isRemoteProcess(known)) return known;
        const handle = new RemoteProcess(ref, sendTo, fromName, (id) => table.release(id));
        // The root is not bound: this side's own end of the connection is the
        // process id 0 already names, and a frame about the root is about the
        // proxy, which arrives without an address.
        if (ref.id !== ROOT_ID) table.bindFar(ref.id, handle);
        return handle;
      };

      let exitResolver: ((v: { code: number | null; state: State }) => void) | null = null;
      const exitPromise = new Promise<{ code: number | null; state: State }>((resolve) => {
        exitResolver = resolve;
      });
      // Setup is done when the far side has said what it holds; until then the
      // one handler below is what takes everything that arrives, so nothing
      // falls between two of them.
      let started: (() => void) | null = null;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });

      channel.onMessage((raw) => {
        const frame = decodeFrame(raw, handleFor);
        // An answer is about the call waiting for it and not about a process: it
        // names the seq, and is settled before anything is looked up.  Every other
        // frame is looked up once, by the process it is about — the root when it says
        // nothing — so which frames a connection accepts is the table's answer, not a
        // rule per frame kind.
        if (calls.settle(frame)) return;
        const to = frameTo(frame);
        const target = to === null ? undefined : table.resolve(to);
        // An id this connection knows nothing about: nothing to deliver to.
        if (!target) return;
        if (isRelease(frame)) {
          // A process of this side's own, let go of over there: nothing more is
          // said about it, and the id is no longer this connection's.  The process
          // itself is untouched.
          if (to !== null) {
            streams.stop(to);
            table.release(to);
          }
          return;
        }
        if (isRemoteProcess(target)) {
          // A process the far side holds.  Its state and its messages are its
          // own, and they go to whoever subscribed to this handle.
          if (isState(frame)) target.receiveState(frame.$state);
          else if (isMsg(frame)) target.receiveMessage(frame.$msg.body as OutMsg, frame.$msg.fromName);
          else if (isExit(frame)) target.receiveExit(frame.$exit);
          else if (isReflectionMethods(frame)) {
            // What the far side holds can answer, and how this side asks it: what
            // was announced is the whole surface, so a name never announced is never
            // called here either.
            target.receiveMethods(frame[REFLECT_METHODS], (method, callArgs) =>
              calls.call(method, callArgs, target.ref.id),
            );
          }
          return;
        }
        if (target !== root) {
          // A process of this side's own, handed over and now spoken to from over
          // there: the message goes where it lives, and control is this side's to
          // act on.  The wire says who sent a message by name alone, so nobody
          // here can be recognised as its parent.
          if (isProcess(target)) {
            if (isMsg(frame)) {
              target.send(frame.$msg.body as InMsg, makeSender(frame.$msg.fromName, null, null));
            } else if (isStop(frame)) void target.stop({ from: makeSender(name, null, null) });
            else if (isPause(frame)) target.pause();
            else if (isResume(frame)) target.resume();
            else if (isTune(frame) && to !== null) {
              // How much the far side hears about a process of this side's own is
              // its to ask, and this is where the asking lands.
              const kinds = tuneFrame(frame);
              if (kinds !== null) streams.tune(to, kinds);
            } else {
              // A call into a process of this side's own, made from over there: the
              // method is this side's to run, and the answer goes back by name and
              // seq, the way the root's does.
              const call = asReflectionCall(frame);
              if (call) void answerCall(call, target, write, table);
            }
          }
          return;
        }
        if (isState(frame)) {
          Object.assign(currentState, frame.$state);
          // $state frames arrive outside this actor's dispatch loop; notify
          // state subscribers so observers (Vue, nextState, …) see the change.
          root.notify();
          started?.();
          started = null;
        } else if (isMsg(frame)) {
          this.emit(frame.$msg.body as OutMsg);
        } else if (isExit(frame)) {
          if (exitResolver) {
            exitResolver({ code: frame.$exit.code, state: frame.$exit.state as State });
            exitResolver = null;
          }
        } else if (isReflectionMethods(frame)) {
          calls.install(
            this.reflection as unknown as Record<string, unknown>,
            frame[REFLECT_METHODS],
            ROOT_ID,
          );
        }
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
        if (exitResolver) {
          exitResolver({ code: null, state: currentState as State });
          exitResolver = null;
        }
      });

      await start;

      return {
        public: currentState as State,
        private: { channel, sendTo, exitPromise, fromName },
      };

    },
    async onMessage(msg: InMsg): Promise<HookResult> {
      const { sendTo, fromName } = this.state.private;
      // A message this side sends is for the root: that is the process the proxy
      // stands for, and a frame that names no process means it.
      sendTo({ $msg: { fromName, body: msg } }, ROOT_ID);
      return stopPropagation();
    },
    async onStopRequested() {
      const { channel, sendTo, exitPromise, fromName } = this.state.private;
      if (channel) {
        sendTo({ $msg: { fromName, body: { type: "STOP" } } }, ROOT_ID);
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

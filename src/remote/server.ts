// ── Server side of the seam ────────────────────────────────────────────────
//
// serveRemoteActor serves a posipaki actor over a frame Channel produced by a
// spawner. It knows only the frame vocabulary (channel.ts) — no protocol, no
// transport, no spawner. The spawner has already done the $proto handshake.

import type { ActorDefinition, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";
import { isInit, isMsg } from "./channel.js";

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
  proc.subscribe("message", async (msg, sender) => {
    try {
      await channel.send({ $msg: { fromName: sender.fromName, body: msg } });
    } catch {
      console.error("Error sending out the message");
    }
  });
  proc.subscribe("state", async () => {
    try {
      await channel.send({ $state: proc.state as Record<string, unknown> });
    } catch (e) {
      console.error("Error sending out the message", e);
    }
  });

  await proc.ready();
  await channel.send({ $state: proc.state as Record<string, unknown> });

  // bridge channel input → actor
  channel.onMessage((frame) => {
    if (isMsg(frame)) {
      const { fromName, body } = frame.$msg;
      proc.send(body as InMsg, makeSender(fromName, parentName, parentId));
    }
  });

  // await actor exit, announce it, close
  let code = 0;
  try {
    await proc.wait();
  } catch (err) {
    console.error("server actor error:", err);
    code = 1;
  }
  await channel.send({ $exit: { code, state: proc.state } });
  await channel.close();
}

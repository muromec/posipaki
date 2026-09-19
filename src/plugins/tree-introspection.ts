import { mergeConfigs } from "../hooks.js";
import type { ActorPlugin, ActorReflection as AR } from "../hooks.js";
import { AnyProcessCtx } from "../types.js";
import type { AnyProcess } from "../process.async.js";

declare module "../index" {
  interface ActorReflection {
    "inspect.getTree": TreeReflectionMethods["inspect.getTree"];
    "inspect.getState": TreeReflectionMethods["inspect.getState"];
    "inspect.find": TreeReflectionMethods["inspect.find"];
    "inspect.exit": TreeReflectionMethods["inspect.exit"];
  }
}

/**
 * A process on the far side of a connection, as it reaches this side: a name, what it
 * holds, the methods it announced and a way to end it.  Structural on purpose — a
 * plugin that walks a tree has no business importing the remote kit, and the far side
 * is only ever asked for what it said it can answer.
 */
export interface FarProcess {
  pname: string;
  state: unknown;
  $reflection: Record<string, (...args: unknown[]) => Promise<unknown>>;
  stop: (opts?: { force?: boolean }) => Promise<unknown>;
}

/** What a search answers with: a process of this side's own, or a handle on one that
 *  lives over a seam.  A handle is not an object of this side's tree — it is how the
 *  other side's process is talked to — so a caller that gets one back has a name it can
 *  ask, and not the local process it would have had. */
export type FoundProcess = AnyProcess | FarProcess;

interface TreeReflectionMethods {
  "inspect.getTree": (prefix?: string) => Promise<TreeNode>;
  "inspect.getState": () => Promise<unknown>;
  "inspect.find": (pname: string) => Promise<FoundProcess | null>;
  "inspect.exit": () => Promise<void>;
}

export interface TreeNode {
  pname: string;
  parentName: string | null;
  children: TreeNode[];
  status: "running" | "no introspection";
}

/** Depth-first search among the processes this side holds. */
function findHeld(procs: Iterable<AnyProcess>, pname: string): AnyProcess | null {
  for (const proc of procs) {
    if (proc.pname === pname) return proc;
    const found = findHeld(proc.children, pname);
    if (found) return found;
  }
  return null;
}

/**
 * The children the name could sit under.  Every name states where it is, so the child a
 * target begins with is the only one that can hold it, and nothing else is asked.  The
 * separator is part of the test: `…:tools` is not above `…:toolshed`.
 */
function childrenThatCouldHold(children: Iterable<AnyProcess>, pname: string): AnyProcess[] {
  const could: AnyProcess[] = [];
  for (const child of children) {
    if (pname.startsWith(`${child.pname}:`)) could.push(child);
  }
  return could;
}

export function inspect(): ActorPlugin {
  return async function inspectPlugin(config) {
    return mergeConfigs(config, {
      $reflectionMethods: {
        ...config.$reflectionMethods,
        "inspect.getTree": async function (prefix?: string): Promise<TreeNode> {
          const children: TreeNode[] = [];
          for (const child of this.ctx.children) {
            const cr = child.$reflection as AR;
            if (typeof cr["inspect.getTree"] === "function") {
              const sub = await cr["inspect.getTree"](prefix);
              if (!prefix || sub.pname.startsWith(prefix)) children.push(sub);
            } else {
              const n = child.pname;
              if (!prefix || n.startsWith(prefix))
                children.push({
                  pname: n,
                  parentName: this.name,
                  children: [],
                  status: "no introspection",
                });
            }
          }
          const selfCtx = this.ctx as AnyProcessCtx;
          return {
            pname: selfCtx.pname,
            parentName: selfCtx.parentName,
            children,
            status: "running" as const,
          } satisfies TreeNode;
        },
        "inspect.getState": async function () {
          const state = this.state as unknown;
          return state;
        },
        /**
         * A process by its full `pname`, wherever it is.
         *
         * This side's own are walked as objects: a name that is here is found here, and
         * the walk over children costs nothing.  What is not here may still exist — a
         * child can be a proxy for a process on the far side of a seam, and what that
         * process holds is not part of this side's object graph, so the walking stops at
         * the wire and no amount of it will help.
         *
         * So the search leaves by asking.  A child announces what the process behind it
         * can answer on the connection's own frames, and a name among them is a function
         * that reaches over there, so nothing has to be agreed about plugins: the far
         * side installs what it installs, and a child that announced `inspect.find` is
         * asked while one that did not is skipped without a word spent on it.
         */
        "inspect.find": async function (pname: string): Promise<FoundProcess | null> {
          const selfCtx = this.ctx as AnyProcessCtx;
          const held = findHeld(selfCtx.children, pname);
          if (held) return held;
          for (const child of childrenThatCouldHold(selfCtx.children, pname)) {
            const surface = (child as { $reflection?: Record<string, unknown> }).$reflection;
            const ask = surface?.["inspect.find"];
            if (typeof ask !== "function") continue;
            const found = (await ask(pname)) as FoundProcess | null;
            if (found) return found;
          }
          return null;
        },
        "inspect.exit": async function () {
          this.exit("inspector");
        },
      },
    });
  };
}

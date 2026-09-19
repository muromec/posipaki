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
         * Written the way the walk is written: a level knows its own children and nothing
         * else, and answers for them one at a time.  A child that is the name is the
         * answer, since it is held here.  A child that can answer is asked and its answer
         * is the answer — what is under it is its own business, and when it lives on the
         * far side of a seam the asking is the only way across.  A child that announces
         * nothing is searched where it is, as a process with no methods still holds its
         * own children as objects.
         *
         * So a search never walks past a child that can speak for itself, and nothing has
         * to be agreed about plugins: a child announces what the process behind it can
         * answer, so the far side serves what its own plugins installed, and a child that
         * installed nothing is simply looked at.
         */
        "inspect.find": async function (pname: string): Promise<FoundProcess | null> {
          const selfCtx = this.ctx as AnyProcessCtx;
          for (const child of selfCtx.children) {
            if (child.pname === pname) return child;
            const surface = (child as { $reflection?: Record<string, unknown> }).$reflection;
            const ask = surface?.["inspect.find"];
            if (typeof ask === "function") {
              const found = (await ask(pname)) as FoundProcess | null;
              if (found) return found;
              continue;
            }
            const under = findHeld(child.children, pname);
            if (under) return under;
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

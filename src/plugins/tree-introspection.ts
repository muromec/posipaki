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

interface TreeReflectionMethods {
  /**
   * The subtree under this process, filtered by `prefix`.  A child reached over
   * a wire answers later, so this is the one method here whose answer may be a
   * promise; the others read what this process already holds.
   */
  "inspect.getTree": (prefix?: string) => TreeNode | Promise<TreeNode>;
  "inspect.getState": () => unknown;
  "inspect.find": (pname: string) => AnyProcess | null;
  "inspect.exit": () => void;
}

export interface TreeNode {
  pname: string;
  parentName: string | null;
  children: TreeNode[];
  status: "running" | "no introspection";
}

/** Depth-first search for a live process by its full `pname`. */
function findProcess(procs: Iterable<AnyProcess>, pname: string): AnyProcess | null {
  for (const proc of procs) {
    if (proc.pname === pname) return proc;
    const found = findProcess(proc.children, pname);
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
              // Awaiting a local child costs a turn of the loop; a child behind
              // a seam answers with a promise, and its subtree is the point.
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
        "inspect.getState": function () {
          const state = this.state as unknown;
          return state;
        },
        "inspect.find": function (pname: string) {
          const selfCtx = this.ctx as AnyProcessCtx;
          return findProcess(selfCtx.children, pname);
        },
        "inspect.exit": function () {
          this.exit("inspector");
        },
      },
    });
  };
}

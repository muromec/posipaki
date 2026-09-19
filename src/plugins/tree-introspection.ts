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
  "inspect.getTree": (prefix?: string) => Promise<TreeNode>;
  "inspect.getState": () => Promise<unknown>;
  "inspect.find": (pname: string) => Promise<AnyProcess | null>;
  "inspect.exit": () => Promise<void>;
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
        "inspect.find": async function (pname: string) {
          const selfCtx = this.ctx as AnyProcessCtx;
          return findProcess(selfCtx.children, pname);
        },
        "inspect.exit": async function () {
          this.exit("inspector");
        },
      },
    });
  };
}

import { mergeConfigs } from "../hooks.js";
import type { ActorPlugin, ActorReflection as AR } from "../hooks.js";
import { AnyProcessCtx } from "../types.js";

declare module "../index" {
  interface ActorReflection {
    "inspect.getTree": TreeReflectionMethods["inspect.getTree"];
    "inspect.getState": TreeReflectionMethods["inspect.getState"];
    "inspect.stop": TreeReflectionMethods["inspect.stop"];
  }
}

interface TreeReflectionMethods {
  "inspect.getTree": (prefix?: string) => TreeNode;
  "inspect.getState": () => unknown;
  "inspect.stop": () => void;
}

export interface TreeNode {
  pname: string;
  parentName: string | null;
  children: TreeNode[];
  status: "running" | "no introspection";
}

export function inspect(): ActorPlugin {
  return async (config) => {
    return mergeConfigs(config, {
      $reflectionMethods: {
        ...config.$reflectionMethods,
        "inspect.getTree": function (prefix?: string) {
          const children: TreeNode[] = [];
          for (const child of Object.values(this.$child)) {
            const cr = child.$reflection as AR;
            if (typeof cr["inspect.getTree"] === "function") {
              const sub = cr["inspect.getTree"](prefix) as TreeNode;
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
        "inspect.stop": function () {
          this.exit("inspector");
        },
      },
    });
  };
}

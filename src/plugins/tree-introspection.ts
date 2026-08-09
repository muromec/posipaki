// ── inspect Plugin ───────────────────────────────────────────────────────
//
// Registers reflection methods for actor tree introspection.
// Built on the Actor Reflection RPC mechanism.
//
// Usage:
//
//   import { inspect } from 'posipaki/plugins/tree-introspection';
//   const MyActor = defineActor({
//     plugins: [inspect()],
//     ...
//   });
//
// Access via proc.$reflection:
//
//   const tree = await rootProc.$reflection['inspect.getTree']();
//   // TreeNode { pname, parentName, children: TreeNode[], status }
//
//   const state = await proc.$reflection['inspect.getState']();
//
//   await proc.$reflection['inspect.stop']();
//
// Filtering:
//
//   const subtree = await proc.$reflection['inspect.getTree']('openai:');
//   // Only includes nodes whose pname starts with 'openai:'
//

import type { ActorPlugin } from '../hooks.js';

// ── types ────────────────────────────────────────────────────────────────

/** A node in the process tree. */
export interface TreeNode {
  /** Actor name (tree-prefixed, e.g. "openai:connector"). */
  pname: string;
  /** Parent actor name, or null for the root. */
  parentName: string | null;
  /** Child subtrees (recursive). */
  children: TreeNode[];
  /** Actor status. */
  status: 'running' | 'no introspection';
}

// ── plugin ───────────────────────────────────────────────────────────────

export function inspect(): ActorPlugin {
  return {
    name: 'inspect',
    install(self) {
      self.reflection.register('getTree', async function (prefix?: string) {
        const children: TreeNode[] = [];
        for (const child of Object.values(this.$child)) {
          const childRefl = (child.$reflection as Record<string, Function>);
          if (typeof childRefl['inspect.getTree'] === 'function') {
            const sub = await childRefl['inspect.getTree'](prefix) as TreeNode;
            if (!prefix || sub.pname.startsWith(prefix)) {
              children.push(sub);
            }
          } else {
            const name = child.pname;
            if (!prefix || name.startsWith(prefix)) {
              children.push({
                pname: name,
                parentName: this.name,
                children: [],
                status: 'no introspection',
              });
            }
          }
        }
        return {
          pname: this.name,
          parentName: this.ctx.parentName,
          children,
          status: 'running' as const,
        } satisfies TreeNode;
      });

      self.reflection.register('getState', function () {
        return this.state;
      });

      self.reflection.register('stop', function () {
        this.agreeToStop();
      });
    },
  };
}

// ── treeIntrospection Plugin ─────────────────────────────────────────────
//
// Registers reflection methods for actor tree introspection.
// Built on the Actor Reflection RPC mechanism.
//
// Usage:
//
//   import { treeIntrospection } from 'posipaki/plugins/tree-introspection';
//   const MyActor = defineActor({
//     plugins: [treeIntrospection()],
//     ...
//   });
//
// Access via proc.$reflection:
//
//   const tree = await rootProc.$reflection['treeIntrospection.getTree']();
//   // { pname, parentName, children: string[], status, info }
//
//   const state = await proc.$reflection['treeIntrospection.getState']();
//
//   await proc.$reflection['treeIntrospection.stop']();
//

import type { ActorPlugin } from '../hooks.js';

// ── types ────────────────────────────────────────────────────────────────

/** A node in the process tree. */
export interface TreeNode {
  /** Actor name (tree-prefixed, e.g. "openai:connector"). */
  pname: string;
  /** Parent actor name, or null for the root. */
  parentName: string | null;
  /** Child actor names (not recursive — walk children to get their subtrees). */
  children: string[];
  /** Actor status. */
  status: 'running' | 'unknown';
  /** Extensible info bag. Plugins or actors can add custom fields. */
  info: Record<string, unknown>;
}

/** Options for treeIntrospection. */
export interface TreeIntrospectionOpts {
  /**
   * Extra fields to include in every TreeNode's `info` bag.
   * Called at query time with the full ActorContext as `this`.
   */
  extraInfo?: (this: any) => Record<string, unknown>;
}

// ── plugin ───────────────────────────────────────────────────────────────

export function treeIntrospection(opts?: TreeIntrospectionOpts): ActorPlugin {
  return {
    name: 'treeIntrospection',
    install(self) {
      self.reflection.register('getTree', function () {
        const children = Object.keys(this.$child);
        const info: Record<string, unknown> = {};
        if (opts?.extraInfo) {
          try {
            Object.assign(info, opts.extraInfo.call(this));
          } catch { /* ignore errors in user-provided extra info */ }
        }
        return {
          pname: this.name,
          parentName: this.ctx.parentName,
          children,
          status: 'running' as const,
          info,
        };
      });

      self.reflection.register('getState', function () {
        try {
          return JSON.parse(JSON.stringify(this.state));
        } catch {
          return '(state not serializable)';
        }
      });

      self.reflection.register('stop', function () {
        this.agreeToStop();
      });
    },
  };
}

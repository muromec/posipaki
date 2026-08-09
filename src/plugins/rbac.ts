// ── rbac Plugin ──────────────────────────────────────────────────────────
//
// Blocks tool execution for tools not in the allowed list.
// Uses stopPropagation() to prevent handlers from running.
//
// Usage:
//   import { rbac } from 'posipaki/plugins/rbac';
//   const MyActor = defineActor({ plugins: [rbac({ allow: ['get_time'] })], ... });

import type { ActorPlugin } from '../hooks.js';
import { stopPropagation } from '../hooks.js';

export interface RbacOpts {
  allow: string[];
}

export function rbac(opts: RbacOpts): ActorPlugin {
  const allowed = new Set(opts.allow);

  return {
    name: 'rbac',
    install(self: any) {
      self.hooks.onMessage((msg: any) => {
        const toolName = msg.toolCall?.function?.name
          ?? msg.type === 'TOOL_EXECUTE' ? (msg as any).toolCall?.function?.name
          : null;

        if (toolName && !allowed.has(toolName)) {
          console.warn(`[${self.name}] blocked tool: ${toolName}`);
          return stopPropagation();
        }
      });
    },
  };
}

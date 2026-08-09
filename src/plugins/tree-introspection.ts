import type { ActorPlugin } from '../hooks.js';
import type { ActorConfig, ActorContext, MethodOptions, HandlerOptions } from '../actor-types.js';
import type { Message } from '../types.js';
import type { AsyncProcess } from '../process.async.js';

export interface TreeNode { pname: string; parentName: string | null; children: TreeNode[]; status: 'running' | 'no introspection'; }

export function inspect(): ActorPlugin {
  return async (config: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>) => {
    config.pluginReflection!.set('inspect.getTree', async function (this: ActorContext<unknown, unknown, Message, Message, MethodOptions, HandlerOptions<Message>>, prefix?: string) {
      const children: TreeNode[] = [];
      for (const child of Object.values(this.$child) as AsyncProcess<unknown, unknown, Message, Message>[]) {
        const cr = (child.$reflection as Record<string, Function>);
        if (typeof cr['inspect.getTree'] === 'function') { const sub = await cr['inspect.getTree'](prefix) as TreeNode; if (!prefix || sub.pname.startsWith(prefix)) children.push(sub); }
        else { const n = child.pname; if (!prefix || n.startsWith(prefix)) children.push({ pname: n, parentName: this.name, children: [], status: 'no introspection' }); }
      }
      return { pname: this.name, parentName: this.ctx.parentName, children, status: 'running' as const } satisfies TreeNode;
    });
    config.pluginReflection!.set('inspect.getState', function (this: any) { return this.state; });
    config.pluginReflection!.set('inspect.stop', function (this: any) { this.agreeToStop(); });
    return config;
  };
}

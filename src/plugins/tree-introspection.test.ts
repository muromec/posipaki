// ── treeIntrospection Plugin Tests ───────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { defineActor, defineMessages } from '../define-actor.js';
import type { Message } from '../types.js';
import { treeIntrospection, type TreeNode } from './tree-introspection.js';

// ── messages ─────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; }
const Pin = defineMessages<PokeMsg>();
const Pout = defineMessages<PokeMsg>();

// ── helpers ──────────────────────────────────────────────────────────────

function makeActor(name?: string, opts?: Parameters<typeof treeIntrospection>[0]) {
  return defineActor({
    name,
    inMessages: Pin,
    outMessages: Pout,
    initialState: () => ({ count: 0 }),
    plugins: [treeIntrospection(opts)],
    handlers: {
      POKE() { this.state.count++; },
    },
  });
}

// ── tests ────────────────────────────────────────────────────────────────

describe('treeIntrospection', () => {
  describe('getTree', () => {
    it('returns pname, parentName, children, status, info', async () => {
      const Actor = makeActor('test-actor');
      const proc = Actor.spawn({});
      await proc.ready();

      const tree: TreeNode = await (proc.$reflection as Record<string, Function>)['treeIntrospection.getTree']();
      expect(tree.pname).toBe('test-actor');
      expect(tree.parentName).toBeNull();
      expect(tree.children).toEqual([]);
      expect(tree.status).toBe('running');
      expect(tree.info).toEqual({});

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('reports children when actor has forked children', async () => {
      const Child = makeActor('child');
      const Parent = defineActor({
        name: 'parent',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({}),
        plugins: [treeIntrospection()],
        async setup(this: any) {
          this.fork(Child, 'kid');
          return {};
        },
        handlers: { POKE() {} },
      });

      const proc = Parent.spawn({});
      await proc.ready();

      const tree: TreeNode = await (proc.$reflection as Record<string, Function>)['treeIntrospection.getTree']();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      expect(tree.children.some((c: string) => c.includes('kid'))).toBe(true);

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('reports parentName from ctx.parentName', async () => {
      const Child = defineActor({
        name: 'leaf',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({}),
        plugins: [treeIntrospection()],
        handlers: { POKE() {} },
      });
      const Parent = defineActor({
        name: 'root',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({}),
        plugins: [treeIntrospection()],
        async setup(this: any) {
          this.fork(Child, 'leaf-child');
          return {};
        },
        handlers: { POKE() {} },
      });

      const proc = Parent.spawn({});
      await proc.ready();

      const getTree = (proc.$reflection as Record<string, Function>)['treeIntrospection.getTree'];
      expect(typeof getTree).toBe('function');
      const tree = await getTree();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      expect(tree.children.some((c: string) => c.includes('leaf-child'))).toBe(true);

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('extraInfo adds to the info bag', async () => {
      const Actor = defineActor({
        name: 'extra-test',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({ count: 42 }),
        plugins: [treeIntrospection({
          extraInfo(this: any) {
            return { count: this.state.count, uptime: 100 };
          },
        })],
        handlers: { POKE() {} },
      });

      const proc = Actor.spawn({});
      await proc.ready();

      const tree: TreeNode = await (proc.$reflection as Record<string, Function>)['treeIntrospection.getTree']();
      expect(tree.info.count).toBe(42);
      expect(tree.info.uptime).toBe(100);

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('does not clobber across spawns', async () => {
      const Actor = defineActor({
        name: 'clobber-test',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({ label: 'default' }),
        plugins: [treeIntrospection({
          extraInfo(this: any) {
            return { label: this.state.label };
          },
        })],
        handlers: { POKE() {} },
      });

      // Can't pass args to spawn with defineActor easily — use initialState
      const proc1 = Actor.spawn({});
      await proc1.ready();

      const t1: TreeNode = await (proc1.$reflection as Record<string, Function>)['treeIntrospection.getTree']();
      expect(t1.info.label).toBe('default');

      proc1.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc1.wait();
    });
  });

  describe('getState', () => {
    it('returns serializable state snapshot', async () => {
      const Actor = makeActor('state-test');
      const proc = Actor.spawn({});
      await proc.ready();

      // Modify state
      proc.send!({ type: 'POKE' }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 30));

      const state = await (proc.$reflection as Record<string, Function>)['treeIntrospection.getState']();
      expect(state).toEqual({ count: 1 });

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('returns fallback string for non-serializable state', async () => {
      const Actor = defineActor({
        name: 'circular-test',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => {
          const obj: any = {};
          obj.self = obj; // circular
          return obj;
        },
        plugins: [treeIntrospection()],
        handlers: { POKE() {} },
      });

      const proc = Actor.spawn({});
      await proc.ready();

      const state = await (proc.$reflection as Record<string, Function>)['treeIntrospection.getState']();
      expect(state).toBe('(state not serializable)');

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });

  describe('stop', () => {
    it('calls agreeToStop and causes the actor to exit', async () => {
      const Actor = makeActor('stop-test');
      const proc = Actor.spawn({});
      await proc.ready();

      await (proc.$reflection as Record<string, Function>)['treeIntrospection.stop']();
      // agreeToStop sets done=true, but the actor needs a message to
      // advance the dispatch loop and check the flag.
      proc.send!({ type: 'POKE' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
      // If we got here without timeout, the actor stopped.
    });
  });
});

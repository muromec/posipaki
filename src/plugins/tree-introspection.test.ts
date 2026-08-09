// ── inspect Plugin Tests ─────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { defineActor, defineMessages } from '../define-actor.js';
import type { Message } from '../types.js';
import { inspect, type TreeNode } from './tree-introspection.js';

// ── messages ─────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; }
const Pin = defineMessages<PokeMsg>();
const Pout = defineMessages<PokeMsg>();

// ── helpers ──────────────────────────────────────────────────────────────

function refl(proc: any): Record<string, Function> {
  return proc.$reflection as Record<string, Function>;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('inspect', () => {
  describe('getTree', () => {
    it('returns pname, parentName, children, status', async () => {
      const Actor = defineActor({
        name: 'test-actor',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({ count: 0 }),
        plugins: [inspect()],
        handlers: { POKE() { this.state.count++; } },
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      const tree: TreeNode = await refl(proc)['inspect.getTree']();
      expect(tree.pname).toBe('test-actor');
      expect(tree.parentName).toBeNull();
      expect(tree.children).toEqual([]);
      expect(tree.status).toBe('running');

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('returns recursive child trees', async () => {
      const Leaf = defineActor({
        name: 'leaf',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        handlers: { POKE() {} },
      });
      const Parent = defineActor({
        name: 'parent',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Leaf, 'kid');
          return {};
        },
        handlers: { POKE() {} },
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const tree: TreeNode = await refl(proc)['inspect.getTree']();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children.find((c: TreeNode) => c.pname.includes('kid'));
      expect(child).toBeDefined();
      expect(child!.status).toBe('running');
      expect(child!.parentName).toBe('parent');

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('marks children without inspect as "no introspection"', async () => {
      const Plain = defineActor({
        name: 'plain',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [], // block inheritance
        handlers: { POKE() {} },
      });
      const Parent = defineActor({
        name: 'root',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Plain, 'plain-child');
          return {};
        },
        handlers: { POKE() {} },
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const tree: TreeNode = await refl(proc)['inspect.getTree']();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children[0];
      expect(child.status).toBe('no introspection');
      expect(child.children).toEqual([]);

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('prefix filters nodes by pname', async () => {
      const Child = defineActor({
        name: 'worker',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        handlers: { POKE() {} },
      });
      const Parent = defineActor({
        name: 'main',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Child, 'w1');
          return {};
        },
        handlers: { POKE() {} },
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      // No prefix — full tree
      const full: TreeNode = await refl(proc)['inspect.getTree']();
      expect(full.pname).toBe('main');
      expect(full.children.length).toBeGreaterThanOrEqual(1);

      // Prefix that matches child
      const filtered: TreeNode = await refl(proc)['inspect.getTree']('main:w1');
      expect(filtered.pname).toBe('main');
      expect(filtered.children.length).toBeGreaterThanOrEqual(1);

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });

    it('does not clobber across spawns', async () => {
      const Actor = defineActor({
        name: 'clobber-test',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({ label: 'default' }),
        plugins: [inspect()],
        handlers: { POKE() {} },
      });

      const proc1 = await Actor.spawn({});
      const proc2 = await Actor.spawn({});
      await proc1.ready();
      await proc2.ready();

      const t1: TreeNode = await refl(proc1)['inspect.getTree']();
      const t2: TreeNode = await refl(proc2)['inspect.getTree']();
      expect(t1.pname).toBe('clobber-test');
      expect(t2.pname).toBe('clobber-test');

      proc1.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      proc2.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc1.wait();
      await proc2.wait();
    });
  });

  describe('getState', () => {
    it('returns raw state', async () => {
      const Actor = defineActor({
        name: 'state-test',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({ count: 0 }),
        plugins: [inspect()],
        handlers: {
          POKE() { this.state.count++; },
        },
      });

      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send!({ type: 'POKE' }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 30));

      const state = await refl(proc)['inspect.getState']();
      expect(state).toEqual({ count: 1 });

      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });

  describe('stop', () => {
    it('calls agreeToStop and causes the actor to exit', async () => {
      const Actor = defineActor({
        name: 'stop-test',
        inMessages: Pin, outMessages: Pout,
        initialState: () => ({}),
        plugins: [inspect()],
        handlers: { POKE() {} },
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      await refl(proc)['inspect.stop']();
      proc.send!({ type: 'POKE' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });
});

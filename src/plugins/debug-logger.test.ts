// ── debugLogger Plugin Tests ────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineActor, defineMessages } from '../define-actor.js';
import type { Message } from '../types.js';
import { debugLogger } from './debug-logger.js';
import type { Logger } from './debug-logger.js';

// ── messages ─────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; value: number; }
interface NopMsg extends Message { type: 'NOP'; }

const Pin = defineMessages<PokeMsg | NopMsg>();
const Pout = defineMessages<PokeMsg>();

// ── helpers ──────────────────────────────────────────────────────────────

interface DebugCall { name: string; msgType: string; kind: string; }

function makeActor(name: string, calls: DebugCall[], opts?: Parameters<typeof debugLogger>[0]) {
  return defineActor({
    name,
    inMessages: Pin,
    outMessages: Pout,
    initialState: () => ({ x: 0 }),
    plugins: [debugLogger(opts)],
    handlers: {
      POKE() { this.state.x = 42; },
      NOP() {},
    },
  });
}

function recordFactory(calls: DebugCall[]): (name: string) => Logger {
  return (name: string) => ({
    debug: (msg: string) => {
      const m = msg.match(/← (\w+)/);
      calls.push({ name, msgType: m ? m[1] : '', kind: 'debug' });
    },
    info: () => {},
    warn: () => {},
    error: (_msg: string) => {},
  });
}

async function sendAndStop(
  proc: Awaited<ReturnType<ReturnType<typeof makeActor>["spawn"]>>,
  msg: PokeMsg | NopMsg,
) {
  await proc.ready();
  proc.send!(msg, { fromName: 'tester', fromId: Symbol('test') });
  await new Promise((r) => setTimeout(r, 30));
  proc.send!({ type: 'STOP' }, { fromName: 'tester', fromId: Symbol('test') });
  await proc.wait();
}

// ── tests ────────────────────────────────────────────────────────────────

describe('debugLogger', () => {
  let calls: DebugCall[];

  beforeEach(() => { calls = []; });
  afterEach(() => { delete process.env.DEBUG; });

  describe('pattern matching', () => {
    it('* matches everything', async () => {
      process.env.DEBUG = '*';
      const Actor = makeActor('some-actor', calls, { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'some-actor')).toBe(true);
    });

    it('prefix:* matches subtree', async () => {
      process.env.DEBUG = 'openai:*';
      const Actor = makeActor('openai:connector', calls, { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'openai:connector')).toBe(true);
    });

    it('exact name match', async () => {
      process.env.DEBUG = 'openai:connector';
      const Actor = makeActor('openai:connector', calls, { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'openai:connector')).toBe(true);
    });

    it('non-matching actor is skipped', async () => {
      process.env.DEBUG = 'openai:connector';
      const Actor = makeActor('openai:tools', calls, { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'openai:tools')).toBe(false);
    });

    it('multiple comma-separated patterns', async () => {
      process.env.DEBUG = 'openai:connector,reflector:*';
      await sendAndStop(await makeActor('openai:connector', calls, { factory: recordFactory(calls) }).spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'openai:connector')).toBe(true);
      calls.length = 0;
      await sendAndStop(await makeActor('reflector:openai', calls, { factory: recordFactory(calls) }).spawn({}), { type: 'POKE', value: 1 });
      expect(calls.some((c) => c.name === 'reflector:openai')).toBe(true);
    });

    it('empty DEBUG skips everything', async () => {
      delete process.env.DEBUG;
      const Actor = makeActor('anything', calls, { factory: recordFactory(calls) });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(calls.length).toBe(0);
    });
  });

  describe('ignore option', () => {
    it('silences listed message types', async () => {
      process.env.DEBUG = '*';
      const Actor = makeActor('ignore-test', calls, { ignore: ['POKE'], factory: recordFactory(calls) });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send!({ type: 'POKE', value: 1 }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.filter((c) => c.msgType === 'POKE').length).toBe(0);
      proc.send!({ type: 'NOP' }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.some((c) => c.msgType === 'NOP')).toBe(true);
      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });

  describe('decoration', () => {
    it('decorates self.log on every actor regardless of DEBUG', async () => {
      delete process.env.DEBUG;
      let decoratedLog: unknown = undefined;
      const Actor = defineActor({
        name: 'decoration-test',
        inMessages: Pin,
        outMessages: Pout,
        initialState: () => ({ x: 0 }),
        plugins: [debugLogger()],
        handlers: {
          POKE(this: any) {
            decoratedLog = this.log;
          },
          NOP() {},
        },
      });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send!({ type: 'POKE', value: 1 }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 30));
      expect(decoratedLog).toBeDefined();
      expect(typeof (decoratedLog as any).debug).toBe('function');
      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });

  describe('custom factory', () => {
    it('uses the provided logger factory', async () => {
      process.env.DEBUG = '*';
      const customCalls: string[] = [];
      const Actor = makeActor('custom-test', calls, {
        factory: (name: string) => ({
          debug: (msg: string) => { customCalls.push(`custom:${name}:${msg}`); },
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      });
      await sendAndStop(await Actor.spawn({}), { type: 'POKE', value: 1 });
      expect(customCalls.length).toBeGreaterThan(0);
      expect(customCalls[0]).toContain('custom:custom-test:');
    });
  });

  describe('integration', () => {
    it('does not interfere with normal operation', async () => {
      process.env.DEBUG = '*';
      const Actor = makeActor('test-int', calls, { factory: recordFactory(calls) });
      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send!({ type: 'POKE', value: 1 }, { fromName: 't', fromId: Symbol('t') });
      await new Promise((r) => setTimeout(r, 50));
      expect((proc.state as any).x).toBe(42);
      proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
      await proc.wait();
    });
  });
});

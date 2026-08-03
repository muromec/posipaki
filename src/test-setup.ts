// @ts-nocheck
// ── test-setup ──────────────────────────────────────────────────────────────
// Preloaded before any test file runs when using bun test.
//
// Shims `vitest` → `bun:test`.

import {
  mock,
  describe,
  it,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spyOn,
} from 'bun:test';

const bunMock = mock;

function makeMockFn(impl?: (...a: unknown[]) => unknown) {
  const fn = (...args: unknown[]) => (impl ?? (() => {}))(...args);
  return Object.assign(fn, {
    mockResolvedValue(v: unknown) { return makeMockFn(() => Promise.resolve(v)); },
    mockRejectedValue(v: unknown) { return makeMockFn(() => Promise.reject(v)); },
    mockReturnValue(v: unknown) { return makeMockFn(() => v); },
  });
}

mock.module('vitest', () => ({
  describe,
  it,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  mock: bunMock,
  vi: {
    mock(p: string, factory?: () => unknown) {
      return bunMock.module(p, factory ?? (() => ({})));
    },
    fn: makeMockFn,
    spyOn,
    resetAllMocks() { bunMock.clearAllMocks?.(); },
    restoreAllMocks() {},
    clearAllMocks() {},
    stubGlobal(name: string, value: unknown) {
      (globalThis as Record<string, unknown>)[name] = value;
    },
    async waitFor(
      fn: () => void | Promise<void>,
      _opts?: { timeout?: number; interval?: number },
    ): Promise<void> {
      const timeout = _opts?.timeout ?? 1000;
      const interval = _opts?.interval ?? 10;
      const deadline = Date.now() + timeout;
      while (true) {
        try {
          await fn();
          return;
        } catch {
          if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeout}ms`);
          await new Promise(r => setTimeout(r, interval));
        }
      }
    },
  },
}));

console.log('[test-setup] vitest shim registered');

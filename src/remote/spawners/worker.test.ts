// ── Worker spawner unit tests (in-memory fakes) ────────────────────────────────

import { describe, it, expect } from "vitest";
import { workerClientSpawner, type WorkerCtor } from "./worker-client.js";
import { workerSelfSpawner } from "./worker-self.js";
import { WORKER_VERSION, type WorkerLike } from "../transports/worker.js";

class FakeWorker implements WorkerLike {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  url: string;
  sent: unknown[] = [];
  terminated = false;

  constructor(url: string, version = WORKER_VERSION) {
    this.url = url;
    FakeWorker.last = this;
    queueMicrotask(() => this.onmessage?.({ data: { $proto: version } }));
  }
  postMessage(data: unknown): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function fakeWorkerCtor(version?: string): WorkerCtor {
  return class extends FakeWorker {
    constructor(url: string) {
      super(url, version);
    }
  } as unknown as WorkerCtor;
}

describe("workerClientSpawner", () => {
  it("connects, validates $proto, and returns a ready channel", async () => {
    const spawner = workerClientSpawner("file://worker.js", fakeWorkerCtor());
    const channelPromise = spawner({ start: 0 });

    const channel = await channelPromise;
    expect(FakeWorker.last!.url).toBe("file://worker.js");

    await channel.send({ $init: { start: 0, parentName: "x", parentIdName: "x" } });
    expect(FakeWorker.last!.sent).toContainEqual({ $init: { start: 0, parentName: "x", parentIdName: "x" } });
  });

  it("rejects an unsupported protocol version", async () => {
    const spawner = workerClientSpawner("file://worker.js", fakeWorkerCtor("wrong.v1"));
    await expect(spawner({})).rejects.toThrow(/unsupported protocol/);
  });
});

describe("workerSelfSpawner", () => {
  it("sends $proto and returns a ready channel", async () => {
    const sent: unknown[] = [];
    const selfScope: WorkerLike = {
      postMessage: (data) => sent.push(data),
      onmessage: null,
      onerror: null,
    };

    const channel = await workerSelfSpawner(selfScope)();
    expect(sent).toEqual([{ $proto: WORKER_VERSION }]);

    await channel.send({ $init: { parentName: "x", parentIdName: "x" } });
    expect(sent[1]).toEqual({ $init: { parentName: "x", parentIdName: "x" } });
  });
});

// ── a cluster: the configuration a node runs from, and the grammar of a name ─
//
// Nothing here has a runtime: what a reference is, how a joined name is spelled, and the one default a cluster carries
// are the whole of the file.

import { describe, expect, it } from "vitest";

import { DEFAULT_CLUSTER, makeCluster, nodeName, nodeRef, refFromName, refOf } from "./cluster.js";

describe("a node's name", () => {
  it("is one atom on the wire, and three fields in a reference", () => {
    const ref = nodeRef("robot", "192.168.88.20", "test");
    expect(nodeName(ref)).toBe("robot@192.168.88.20");
    expect(refFromName("robot@192.168.88.20", "test")).toEqual(ref);
    expect(refOf({ kind: "pid", node: "robot@192.168.88.20", id: 1, serial: 0, creation: 7 }, "test")).toEqual(ref);
  });

  it("is refused when it names no host", () => {
    expect(() => refFromName("nobody", "test")).toThrow("nobody is not a node name: it has no host");
  });
});

describe("a cluster's configuration", () => {
  it("is called default until a caller names it, and is otherwise what it was given", () => {
    const made = makeCluster({ self: "me@127.0.0.1", cookie: "pocookie", creation: 7 });
    expect(made.name).toBe(DEFAULT_CLUSTER);
    expect(made).toMatchObject({ self: "me@127.0.0.1", cookie: "pocookie", creation: 7 });
  });
});

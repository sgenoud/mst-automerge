import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { getSnapshot, onPatch, types } from "mobx-state-tree";
import { docToSnapshot, snapshotToDoc } from "../src/convert";
import { bindMSTToAutomerge } from "../src/bind";

const Todo = types.model("Todo", {
  title: types.string,
  done: false,
});

const Store = types
  .model("Store", {
    title: "untitled",
    arr: types.array(types.number),
    todos: types.array(Todo),
    map: types.map(types.number),
  })
  .actions((self) => ({
    run(fn: (s: typeof self) => void) {
      fn(self);
    },
  }));

function makeHandle(seed?: Record<string, unknown>) {
  const repo = new Repo({ network: [] });
  const handle = repo.create<any>();
  if (seed) handle.change((d: any) => snapshotToDoc(seed, d));
  return handle;
}

function expectConverged(node: any, handle: any) {
  expect(docToSnapshot(handle.doc())).toEqual(
    JSON.parse(JSON.stringify(getSnapshot(node))),
  );
}

describe("bindMSTToAutomerge: bootstrap", () => {
  it("seeds an empty doc from initialSnapshot, including type defaults", async () => {
    const handle = makeHandle();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: { title: "seeded" },
    });
    expect(node.title).toBe("seeded");
    // defaults the snapshot omitted are materialized in the doc too
    expect(docToSnapshot(handle.doc())).toEqual({
      title: "seeded",
      arr: [],
      todos: [],
      map: {},
    });
    expectConverged(node, handle);
  });

  it("lets the doc win over initialSnapshot when the doc has content", async () => {
    const handle = makeHandle({
      title: "remote truth",
      arr: [1],
      todos: [],
      map: {},
    });
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: { title: "local seed", arr: [9, 9, 9] },
    });
    expect(node.title).toBe("remote truth");
    expect([...node.arr]).toEqual([1]);
    expectConverged(node, handle);
  });

  it("builds the tree from a non-empty doc without a snapshot, writing back only missing defaults", async () => {
    const handle = makeHandle({ title: "sparse" });
    const before = A.getHistory(handle.doc()).length;
    const { node } = await bindMSTToAutomerge({ type: Store, handle });
    expect(node.title).toBe("sparse");
    expectConverged(node, handle);

    // write-back happened once; binding the complete doc again adds nothing
    expect(A.getHistory(handle.doc()).length).toBe(before + 1);
    const again = await bindMSTToAutomerge({ type: Store, handle });
    again.dispose();
    expect(A.getHistory(handle.doc()).length).toBe(before + 1);
  });

  it("rejects when the doc is empty, no snapshot is given, and the type has required props", async () => {
    const Strict = types.model("Strict", { req: types.string });
    const handle = makeHandle();
    await expect(
      bindMSTToAutomerge({ type: Strict, handle }),
    ).rejects.toThrow();
  });
});

describe("bindMSTToAutomerge: two-way sync", () => {
  it("syncs local actions out and remote changes in", async () => {
    const handle = makeHandle();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: {},
    });

    node.run((s) => {
      s.title = "from mst";
      s.arr.push(1);
    });
    expect(handle.doc().title).toBe("from mst");

    handle.change((d: any) => {
      d.todos.push({ title: "from automerge", done: true });
    });
    expect(node.todos[0]!.title).toBe("from automerge");
    expectConverged(node, handle);
  });

  it("does not echo local changes back onto the tree", async () => {
    const handle = makeHandle();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: {},
    });

    let patchCount = 0;
    onPatch(node, () => patchCount++);
    const before = A.getHistory(handle.doc()).length;

    node.run((s) => {
      s.title = "once";
      s.arr.push(1);
    });

    // 2 mutations -> exactly 2 tree patches (an echo would re-apply them)
    expect(patchCount).toBe(2);
    // ...and exactly one Automerge change
    expect(A.getHistory(handle.doc()).length).toBe(before + 1);
    expectConverged(node, handle);
  });

  it("does not echo remote changes back into the doc", async () => {
    const handle = makeHandle();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: {},
    });

    handle.change((d: any) => {
      d.title = "remote";
      d.map.k = 1;
    });
    const after = A.getHistory(handle.doc()).length;

    // microtask drain: an echo via the outbound buffer would flush here
    await new Promise((r) => setTimeout(r, 0));
    expect(A.getHistory(handle.doc()).length).toBe(after);
    expect(node.title).toBe("remote");
    expectConverged(node, handle);
  });

  it("survives alternating ping-pong edits without diverging", async () => {
    const handle = makeHandle();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: {},
    });

    for (let i = 0; i < 5; i++) {
      node.run((s) => s.arr.push(i));
      handle.change((d: any) => {
        d.map[`k${i}`] = i;
      });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(node.arr).toHaveLength(5);
    expect(node.map.size).toBe(5);
    expectConverged(node, handle);
  });
});

describe("bindMSTToAutomerge: dispose", () => {
  it("detaches both directions and supports rebinding", async () => {
    const handle = makeHandle();
    const first = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: { title: "v1" },
    });
    first.dispose();

    first.node.run((s) => (s.title = "unsynced"));
    handle.change((d: any) => {
      d.title = "unseen";
    });
    expect(handle.doc().title).toBe("unseen");
    expect(first.node.title).toBe("unsynced");

    const second = await bindMSTToAutomerge({ type: Store, handle });
    expect(second.node.title).toBe("unseen");
    second.node.run((s) => (s.title = "rebound"));
    expect(handle.doc().title).toBe("rebound");
    expectConverged(second.node, handle);
  });
});

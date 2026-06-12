import { beforeEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import {
  applyPatch,
  applySnapshot,
  getSnapshot,
  types,
  type Instance,
} from "mobx-state-tree";
import { docToSnapshot, snapshotToDoc } from "../src/convert";
import { bindOutbound } from "../src/outbound";

const Todo = types.model("Todo", {
  title: types.string,
  done: false,
});

const Store = types
  .model("Store", {
    title: "list",
    arr: types.array(types.number),
    todos: types.array(Todo),
    map: types.map(types.number),
    maybe: types.maybe(types.string),
  })
  .actions((self) => ({
    run(fn: (s: typeof self) => void) {
      fn(self);
    },
  }));

const initial = {
  title: "list",
  arr: [1, 2, 3],
  todos: [{ title: "a", done: false }],
  map: { x: 1 },
  maybe: "yes",
} as const;

let store: Instance<typeof Store>;
let handle: DocHandle<any>;
let dispose: () => void;
let amPatches: A.Patch[];

beforeEach(() => {
  store = Store.create(structuredClone(initial) as any);
  const repo = new Repo({ network: [] });
  handle = repo.create<any>();
  handle.change((d: any) => snapshotToDoc(getSnapshot(store), d));
  amPatches = [];
  handle.on("change", ({ patches }) => amPatches.push(...patches));
  dispose = bindOutbound(store, handle);
});

/** The invariant: after any synced action, doc content === tree snapshot. */
function expectDocMatchesTree() {
  expect(docToSnapshot(handle.doc())).toEqual(
    JSON.parse(JSON.stringify(getSnapshot(store))),
  );
}

describe("bindOutbound: MST -> Automerge", () => {
  it("syncs primitive replaces at root and nested paths", () => {
    store.run((s) => (s.title = "renamed"));
    expect(handle.doc().title).toBe("renamed");

    store.run((s) => (s.todos[0]!.title = "deep"));
    expect(handle.doc().todos[0].title).toBe("deep");
    expectDocMatchesTree();
  });

  it("syncs map add, replace and delete", () => {
    store.run((s) => s.map.set("y", 2));
    store.run((s) => s.map.set("x", 10));
    store.run((s) => s.map.delete("x"));
    expect(docToSnapshot(handle.doc())).toMatchObject({ map: { y: 2 } });
    expectDocMatchesTree();
  });

  it("removes the key when an optional becomes undefined", () => {
    store.run((s) => (s.maybe = undefined));
    expect("maybe" in handle.doc()).toBe(false);
    expectDocMatchesTree();
  });

  it("syncs array push, unshift and mid-array insert as CRDT inserts", () => {
    store.run((s) => s.arr.push(4));
    store.run((s) => s.arr.unshift(0));
    store.run((s) => s.arr.splice(2, 0, 99));
    expect([...handle.doc().arr]).toEqual([0, 1, 99, 2, 3, 4]);

    // merging depends on real inserts: index assignment would emit put
    const inserts = amPatches.filter((p) => p.action === "insert");
    expect(inserts.length).toBe(3);
    expect(amPatches.filter((p) => p.action === "put")).toEqual([]);
    expectDocMatchesTree();
  });

  it("syncs array removal and in-place replacement", () => {
    store.run((s) => s.arr.splice(1, 1));
    expect([...handle.doc().arr]).toEqual([1, 3]);

    store.run((s) => (s.arr[0] = 100));
    expect([...handle.doc().arr]).toEqual([100, 3]);
    expectDocMatchesTree();
  });

  it("syncs a replacing splice and whole-array assignment", () => {
    store.run((s) => s.arr.splice(1, 2, 7, 8, 9));
    expect([...handle.doc().arr]).toEqual([1, 7, 8, 9]);

    store.run((s) => (s.arr = [5, 5] as any));
    expect([...handle.doc().arr]).toEqual([5, 5]);
    expectDocMatchesTree();
  });

  it("syncs object inserts into model arrays", () => {
    store.run((s) => s.todos.push(Todo.create({ title: "b", done: true })));
    expect(docToSnapshot(handle.doc())).toMatchObject({
      todos: [
        { title: "a", done: false },
        { title: "b", done: true },
      ],
    });
    expectDocMatchesTree();
  });

  it("batches all mutations of one action into a single Automerge change", () => {
    const before = A.getHistory(handle.doc()).length;
    store.run((s) => {
      s.title = "a";
      s.arr.push(6);
      s.map.set("z", 3);
      s.title = "b";
      s.arr.pop();
    });
    expect(A.getHistory(handle.doc()).length).toBe(before + 1);
    expectDocMatchesTree();
  });

  it("syncs applySnapshot and applyPatch like any other action", () => {
    applySnapshot(store, { title: "snap", arr: [42] });
    expectDocMatchesTree();
    expect("maybe" in handle.doc()).toBe(false);

    applyPatch(store, { op: "replace", path: "/title", value: "patched" });
    expect(handle.doc().title).toBe("patched");
    expectDocMatchesTree();
  });

  it("stops syncing after dispose", () => {
    dispose();
    store.run((s) => (s.title = "silent"));
    expect(handle.doc().title).toBe("list");
  });
});

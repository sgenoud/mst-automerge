import { beforeEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { getSnapshot, onSnapshot, types, type Instance } from "mobx-state-tree";
import { docToSnapshot, snapshotToDoc } from "../src/convert";
import { bindInbound } from "../src/inbound";

const Todo = types.model("Todo", {
  title: types.string,
  done: false,
});

const Store = types.model("Store", {
  title: "hello",
  arr: types.array(types.number),
  strs: types.array(types.string),
  todos: types.array(Todo),
  map: types.map(types.number),
  maybe: types.maybe(types.string),
});

const initial = {
  title: "hello",
  arr: [1, 2, 3],
  strs: ["a"],
  todos: [{ title: "first", done: false }],
  map: { x: 1 },
  maybe: "yes",
};

let store: Instance<typeof Store>;
let handle: DocHandle<any>;
let dispose: () => void;

beforeEach(() => {
  const repo = new Repo({ network: [] });
  handle = repo.create<any>();
  handle.change((d: any) => snapshotToDoc(initial, d));
  store = Store.create(docToSnapshot(handle.doc()) as any);
  dispose = bindInbound(store, handle);
});

/** The invariant: after any remote change, tree snapshot === doc content. */
function expectTreeMatchesDoc() {
  expect(JSON.parse(JSON.stringify(getSnapshot(store)))).toEqual(
    docToSnapshot(handle.doc()),
  );
}

describe("bindInbound: Automerge -> MST", () => {
  it("applies primitive puts (string assignment arrives as put + splice)", () => {
    handle.change((d: any) => {
      d.title = "renamed";
    });
    expect(store.title).toBe("renamed");

    handle.change((d: any) => {
      d.todos[0].done = true;
    });
    expect(store.todos[0]!.done).toBe(true);
    expectTreeMatchesDoc();
  });

  it("applies granular text edits to plain string fields", () => {
    handle.change((d: any) => {
      A.splice(d, ["title"], 5, 0, " world");
    });
    expect(store.title).toBe("hello world");

    handle.change((d: any) => {
      A.splice(d, ["title"], 0, 5, "goodbye");
    });
    expect(store.title).toBe("goodbye world");
    expectTreeMatchesDoc();
  });

  it("grafts a pushed object (insert of empty container + fill puts)", () => {
    handle.change((d: any) => {
      d.todos.push({ title: "second", done: true });
    });
    expect(store.todos).toHaveLength(2);
    expect(getSnapshot(store.todos[1]!)).toEqual({
      title: "second",
      done: true,
    });
    expectTreeMatchesDoc();
  });

  it("grafts an object inserted mid-list, shifting existing elements", () => {
    handle.change((d: any) => {
      d.todos.insertAt(0, { title: "zeroth", done: false });
    });
    expect(store.todos[0]!.title).toBe("zeroth");
    expect(store.todos[1]!.title).toBe("first");
    expectTreeMatchesDoc();
  });

  it("inserts plain strings into arrays (string list values arrive as empty string + splice)", () => {
    handle.change((d: any) => {
      d.strs.push("hello");
      d.strs.insertAt(0, "first");
    });
    expect([...store.strs]).toEqual(["first", "a", "hello"]);
    expectTreeMatchesDoc();
  });

  it("applies list inserts, single and multi-element deletes", () => {
    handle.change((d: any) => {
      d.arr.insertAt(1, 9, 10);
    });
    expect([...store.arr]).toEqual([1, 9, 10, 2, 3]);

    handle.change((d: any) => {
      d.arr.deleteAt(0);
    });
    expect([...store.arr]).toEqual([9, 10, 2, 3]);

    handle.change((d: any) => {
      d.arr.splice(1, 2);
    });
    expect([...store.arr]).toEqual([9, 3]);
    expectTreeMatchesDoc();
  });

  it("applies map adds, replaces and deletes", () => {
    handle.change((d: any) => {
      d.map.y = 2;
      d.map.x = 10;
    });
    expect(store.map.get("y")).toBe(2);
    expect(store.map.get("x")).toBe(10);

    handle.change((d: any) => {
      delete d.map.x;
    });
    expect(store.map.has("x")).toBe(false);
    expectTreeMatchesDoc();
  });

  it("clears an optional model prop when its key is deleted", () => {
    handle.change((d: any) => {
      delete d.maybe;
    });
    expect(store.maybe).toBeUndefined();
    expectTreeMatchesDoc();
  });

  it("preserves node identity when a sibling field changes", () => {
    const todoBefore = store.todos[0]!;
    handle.change((d: any) => {
      d.todos[0].title = "still me";
    });
    expect(store.todos[0]).toBe(todoBefore);
    expect(todoBefore.title).toBe("still me");
  });

  it("applies one remote change as a single MobX transaction", () => {
    let ticks = 0;
    onSnapshot(store, () => ticks++);
    handle.change((d: any) => {
      d.title = "multi";
      for (let i = 0; i < 8; i++) d.map[`k${i}`] = i;
      d.arr.push(4);
    });
    expect(ticks).toBe(1);
    expectTreeMatchesDoc();
  });

  it("stops applying after dispose", () => {
    dispose();
    handle.change((d: any) => {
      d.title = "silent";
    });
    expect(store.title).toBe("hello");
  });
});

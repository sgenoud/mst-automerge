import { afterEach, describe, expect, it, vi } from "vitest";
import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { getSnapshot, types } from "mobx-state-tree";
import { bindMSTToAutomerge, createDocFromTree } from "../src/bind";
import { docToSnapshot, snapshotToDoc } from "../src/convert";
import { AutomergeCounter } from "../src/primitives/counter";
import { AutomergeText } from "../src/primitives/text";

let repos: Repo[] = [];

afterEach(async () => {
  for (const repo of repos) await repo.shutdown();
  repos = [];
});

function makeRepo() {
  const repo = new Repo({ network: [] });
  repos.push(repo);
  return repo;
}

describe("createDocFromTree", () => {
  it("creates a doc matching an unbound tree, with counters as Counter instances", () => {
    const Store = types.model("Store", {
      title: types.optional(AutomergeText, ""),
      hits: types.optional(AutomergeCounter, 0),
      tags: types.array(types.string),
    });
    const node = Store.create({ title: "hello", hits: 4, tags: ["x"] });

    const handle = createDocFromTree(makeRepo(), node);
    expect(docToSnapshot(handle.doc())).toEqual(
      JSON.parse(JSON.stringify(getSnapshot(node))),
    );
    expect((handle.doc() as any).hits).toBeInstanceOf(A.Counter);
  });

  it("produces a handle that binds back without extra changes", async () => {
    const Store = types.model("Store", {
      hits: types.optional(AutomergeCounter, 0),
      tags: types.array(types.string),
    });
    const node = Store.create({ hits: 2, tags: ["a"] });
    const handle = createDocFromTree(makeRepo(), node);

    const before = A.getHistory(handle.doc()).length;
    const binding = await bindMSTToAutomerge({ type: Store, handle });
    expect(A.getHistory(handle.doc()).length).toBe(before);
    expect(binding.node.hits.value).toBe(2);
  });
});

describe("bind-time type errors", () => {
  it("rejects with a contextual error when the doc does not satisfy the type", async () => {
    const Strict = types.model("Strict", { req: types.string });
    const repo = makeRepo();
    const handle = repo.create<any>();
    handle.change((d: any) => {
      d.req = 123;
    });

    await expect(bindMSTToAutomerge({ type: Strict, handle })).rejects.toThrow(
      /mst-automerge.*Strict/s,
    );
  });
});

describe("onSyncError", () => {
  const Strict = types
    .model("Strict", { req: types.string, n: 0 })
    .actions((self) => ({
      run(fn: (s: typeof self) => void) {
        fn(self);
      },
    }));

  it("reports inbound failures instead of throwing, and recovers on the next valid change", async () => {
    const repo = makeRepo();
    const handle = repo.create<any>();
    handle.change((d: any) => snapshotToDoc({ req: "ok", n: 0 }, d));

    const errors: unknown[] = [];
    const { node } = await bindMSTToAutomerge({
      type: Strict,
      handle,
      onSyncError: (e) => errors.push(e),
    });

    // a remote change that violates the MST type
    handle.change((d: any) => {
      d.req = 123;
    });
    expect(errors).toHaveLength(1);
    expect(node.req).toBe("ok"); // tree kept its last valid state

    // the doc heals; the next event resyncs the whole tree
    handle.change((d: any) => {
      d.req = "fixed";
      d.n = 7;
    });
    expect(node.req).toBe("fixed");
    expect(node.n).toBe(7);
    expect(errors).toHaveLength(1);
  });

  it("reports to console.error by default (DocHandle decouples emit, so throwing is unreachable noise)", async () => {
    const repo = makeRepo();
    const handle = repo.create<any>();
    handle.change((d: any) => snapshotToDoc({ req: "ok", n: 0 }, d));
    const { node } = await bindMSTToAutomerge({ type: Strict, handle });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handle.change((d: any) => {
        d.req = 123;
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(String(spy.mock.calls[0]![0])).toContain("mst-automerge");
      expect(node.req).toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("frozen and odd-key semantics", () => {
  it("syncs types.frozen subtrees as opaque LWW values", async () => {
    const Store = types
      .model("Store", { config: types.frozen<any>({}) })
      .actions((self) => ({
        setConfig(c: any) {
          self.config = c;
        },
      }));
    const repo = makeRepo();
    const handle = repo.create<any>();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: { config: { a: 1 } },
    });

    node.setConfig({ b: [1, 2], nested: { deep: true } });
    expect(docToSnapshot(handle.doc())).toEqual({
      config: { b: [1, 2], nested: { deep: true } },
    });

    handle.change((d: any) => {
      d.config = { remote: true };
    });
    expect(node.config).toEqual({ remote: true });
  });

  it("round-trips map keys that look numeric", async () => {
    const Store = types
      .model("Store", { byId: types.map(types.string) })
      .actions((self) => ({
        set(k: string, v: string) {
          self.byId.set(k, v);
        },
      }));
    const repo = makeRepo();
    const handle = repo.create<any>();
    const { node } = await bindMSTToAutomerge({
      type: Store,
      handle,
      initialSnapshot: {},
    });

    node.set("0", "zero");
    node.set("01", "padded");
    node.set("42", "answer");
    expect(docToSnapshot(handle.doc())).toEqual({
      byId: { "0": "zero", "01": "padded", "42": "answer" },
    });

    handle.change((d: any) => {
      d.byId["7"] = "remote";
    });
    expect(node.byId.get("7")).toBe("remote");
  });
});

describe("performance smoke (generous bounds; catches quadratic blowups)", () => {
  const Item = types.model("Item", { title: types.string, done: false });
  const Big = types
    .model("Big", { items: types.array(Item) })
    .actions((self) => ({
      run(fn: (s: typeof self) => void) {
        fn(self);
      },
    }));

  it("bootstraps 2k nodes and absorbs 500 local + 100 remote ops", async () => {
    const N = 2000;
    const seed = {
      items: Array.from({ length: N }, (_, i) => ({
        title: `item ${i}`,
        done: false,
      })),
    };
    const repo = makeRepo();
    const handle = repo.create<any>();

    const t0 = performance.now();
    const { node } = await bindMSTToAutomerge({
      type: Big,
      handle,
      initialSnapshot: seed,
    });
    const bootstrapMs = performance.now() - t0;
    expect(bootstrapMs).toBeLessThan(10_000);

    const t1 = performance.now();
    for (let batch = 0; batch < 10; batch++) {
      node.run((s) => {
        for (let i = 0; i < 50; i++) {
          const idx = (batch * 50 + i * 7) % s.items.length;
          s.items[idx]!.done = !s.items[idx]!.done;
        }
      });
    }
    const localMs = performance.now() - t1;
    expect(localMs).toBeLessThan(10_000);

    const t2 = performance.now();
    for (let i = 0; i < 100; i++) {
      handle.change((d: any) => {
        d.items[(i * 13) % N].title = `remote ${i}`;
      });
    }
    const remoteMs = performance.now() - t2;
    expect(remoteMs).toBeLessThan(10_000);

    expect(JSON.parse(JSON.stringify(getSnapshot(node)))).toEqual(
      docToSnapshot(handle.doc()),
    );
  }, 60_000);
});

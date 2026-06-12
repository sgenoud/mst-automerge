import { afterEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import fc from "fast-check";
import { getSnapshot, types, type Instance } from "mobx-state-tree";
import { bindMSTToAutomerge } from "../src/bind";
import { docToSnapshot, snapshotToDoc } from "../src/convert";

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

type StoreInstance = Instance<typeof Store>;

const seed = {
  title: "shared",
  arr: [1, 2, 3],
  todos: [
    { title: "a", done: false },
    { title: "b", done: false },
  ],
  map: { x: 1 },
};

let repos: Repo[] = [];

afterEach(async () => {
  for (const repo of repos) await repo.shutdown();
  repos = [];
});

async function makePair() {
  const { port1, port2 } = new MessageChannel();
  const repoA = new Repo({
    network: [new MessageChannelNetworkAdapter(port1)],
    peerId: "peer-a" as any,
  });
  const repoB = new Repo({
    network: [new MessageChannelNetworkAdapter(port2)],
    peerId: "peer-b" as any,
  });
  repos.push(repoA, repoB);

  const handleA = repoA.create<any>();
  handleA.change((d: any) => snapshotToDoc(seed, d));
  const a = await bindMSTToAutomerge({ type: Store, handle: handleA });

  const handleB = await repoB.find<any>(handleA.url);
  const b = await bindMSTToAutomerge({ type: Store, handle: handleB });

  return { handleA, handleB, nodeA: a.node, nodeB: b.node };
}

const sortedHeads = (h: DocHandle<any>) =>
  JSON.stringify([...A.getHeads(h.doc())].sort());

async function settle(
  hA: DocHandle<any>,
  hB: DocHandle<any>,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (sortedHeads(hA) !== sortedHeads(hB)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("documents did not converge within the timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  // let any change events queued behind the last message drain
  await new Promise((r) => setTimeout(r, 10));
}

function expectConverged(
  nodeA: StoreInstance,
  nodeB: StoreInstance,
  hA: DocHandle<any>,
  hB: DocHandle<any>,
) {
  const snapA = JSON.parse(JSON.stringify(getSnapshot(nodeA)));
  const snapB = JSON.parse(JSON.stringify(getSnapshot(nodeB)));
  expect(snapA).toEqual(snapB);
  expect(docToSnapshot(hA.doc())).toEqual(docToSnapshot(hB.doc()));
  expect(snapA).toEqual(docToSnapshot(hA.doc()));
}

describe("convergence across two repos", () => {
  it("propagates an edit from A's tree to B's tree", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makePair();
    nodeA.run((s) => (s.title = "hello from A"));
    await settle(handleA, handleB);
    expect(nodeB.title).toBe("hello from A");
    expectConverged(nodeA, nodeB, handleA, handleB);
  });

  it("delivers a remote batch (object pushes + field edits) into the tree", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makePair();
    nodeA.run((s) => {
      s.todos.push(Todo.create({ title: "c", done: true }));
      s.todos.push(Todo.create({ title: "d", done: false }));
      s.title = "batched";
      s.map.set("y", 2);
    });
    await settle(handleA, handleB);
    expect(nodeB.todos).toHaveLength(4);
    expect(nodeB.todos[2]!.title).toBe("c");
    expect(nodeB.todos[3]!.done).toBe(false);
    expectConverged(nodeA, nodeB, handleA, handleB);
  });

  it("converges concurrent disjoint edits", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makePair();
    // same tick: neither side has seen the other's edit yet
    nodeA.run((s) => (s.todos[0]!.done = true));
    nodeB.run((s) => (s.todos[1]!.title = "edited on B"));
    await settle(handleA, handleB);
    expect(nodeA.todos[0]!.done).toBe(true);
    expect(nodeA.todos[1]!.title).toBe("edited on B");
    expectConverged(nodeA, nodeB, handleA, handleB);
  });

  it("converges concurrent same-index list inserts, keeping both elements", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makePair();
    nodeA.run((s) => s.arr.splice(1, 0, 100));
    nodeB.run((s) => s.arr.splice(1, 0, 200));
    await settle(handleA, handleB);
    expect(nodeA.arr).toHaveLength(5);
    expect([...nodeA.arr]).toContain(100);
    expect([...nodeA.arr]).toContain(200);
    expectConverged(nodeA, nodeB, handleA, handleB);
  });

  it("converges concurrent writes to the same field (one side wins, both agree)", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makePair();
    nodeA.run((s) => (s.title = "A wins?"));
    nodeB.run((s) => (s.title = "B wins?"));
    await settle(handleA, handleB);
    expect(["A wins?", "B wins?"]).toContain(nodeA.title);
    expectConverged(nodeA, nodeB, handleA, handleB);
  });

  it("merges offline divergence (clone, edit both, merge both ways)", async () => {
    const repo = new Repo({ network: [] });
    repos.push(repo);
    const handleA = repo.create<any>();
    handleA.change((d: any) => snapshotToDoc(seed, d));
    const handleB = repo.clone(handleA);

    const a = await bindMSTToAutomerge({ type: Store, handle: handleA });
    const b = await bindMSTToAutomerge({ type: Store, handle: handleB });

    // "offline": the two handles share history but are not connected
    a.node.run((s) => {
      s.arr.push(99);
      s.todos[0]!.done = true;
    });
    b.node.run((s) => {
      s.map.set("offline", 1);
      s.todos[1]!.title = "edited offline";
    });

    // "reconnect"
    handleA.merge(handleB);
    handleB.merge(handleA);

    expect([...a.node.arr]).toEqual([1, 2, 3, 99]);
    expect(a.node.map.get("offline")).toBe(1);
    expect(b.node.todos[0]!.done).toBe(true);
    expect(b.node.todos[1]!.title).toBe("edited offline");
    expectConverged(a.node, b.node, handleA, handleB);
  });
});

describe("convergence property", () => {
  type Op =
    | { kind: "set-title"; v: string }
    | { kind: "push"; v: number }
    | { kind: "insert"; i: number; v: number }
    | { kind: "del-arr"; i: number }
    | { kind: "replace-arr"; i: number; v: number }
    | { kind: "set-map"; k: string; v: number }
    | { kind: "del-map"; k: string }
    | { kind: "push-todo"; title: string }
    | { kind: "toggle-todo"; i: number };

  const word = fc.constantFrom("alpha", "beta", "gamma", "delta", "epsilon");
  const key = fc.constantFrom("a", "b", "c");
  const num = fc.integer({ min: 0, max: 99 });
  const idx = fc.nat({ max: 10 });

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("set-title" as const), v: word }),
    fc.record({ kind: fc.constant("push" as const), v: num }),
    fc.record({ kind: fc.constant("insert" as const), i: idx, v: num }),
    fc.record({ kind: fc.constant("del-arr" as const), i: idx }),
    fc.record({ kind: fc.constant("replace-arr" as const), i: idx, v: num }),
    fc.record({ kind: fc.constant("set-map" as const), k: key, v: num }),
    fc.record({ kind: fc.constant("del-map" as const), k: key }),
    fc.record({ kind: fc.constant("push-todo" as const), title: word }),
    fc.record({ kind: fc.constant("toggle-todo" as const), i: idx }),
  );

  function applyOp(node: StoreInstance, op: Op) {
    node.run((s) => {
      switch (op.kind) {
        case "set-title":
          s.title = op.v;
          break;
        case "push":
          s.arr.push(op.v);
          break;
        case "insert":
          s.arr.splice(op.i % (s.arr.length + 1), 0, op.v);
          break;
        case "del-arr":
          if (s.arr.length > 0) s.arr.splice(op.i % s.arr.length, 1);
          break;
        case "replace-arr":
          if (s.arr.length > 0) s.arr[op.i % s.arr.length] = op.v;
          break;
        case "set-map":
          s.map.set(op.k, op.v);
          break;
        case "del-map":
          s.map.delete(op.k);
          break;
        case "push-todo":
          s.todos.push({ title: op.title, done: false });
          break;
        case "toggle-todo":
          if (s.todos.length > 0) {
            const t = s.todos[op.i % s.todos.length]!;
            t.done = !t.done;
          }
          break;
      }
    });
  }

  it("random concurrent op interleavings on both sides always converge", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { maxLength: 10 }),
        fc.array(opArb, { maxLength: 10 }),
        async (opsA, opsB) => {
          const { handleA, handleB, nodeA, nodeB } = await makePair();
          // interleave applications without awaiting: genuinely concurrent
          const max = Math.max(opsA.length, opsB.length);
          for (let i = 0; i < max; i++) {
            if (opsA[i]) applyOp(nodeA, opsA[i]!);
            if (opsB[i]) applyOp(nodeB, opsB[i]!);
          }
          await settle(handleA, handleB, 10_000);
          const snapA = JSON.parse(JSON.stringify(getSnapshot(nodeA)));
          const snapB = JSON.parse(JSON.stringify(getSnapshot(nodeB)));
          expect(snapA).toEqual(snapB);
          expect(snapA).toEqual(docToSnapshot(handleA.doc()));
          // tear down this run's repos eagerly
          for (const repo of repos) await repo.shutdown();
          repos = [];
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

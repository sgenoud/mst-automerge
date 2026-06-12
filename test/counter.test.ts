import { afterEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { autorun } from "mobx";
import {
  applySnapshot,
  getSnapshot,
  types,
  type Instance,
} from "mobx-state-tree";
import { bindMSTToAutomerge } from "../src/bind";
import { docToSnapshot } from "../src/convert";
import { AutomergeCounter } from "../src/primitives/counter";

const Todo = types.model("Todo", {
  title: types.string,
  votes: types.optional(AutomergeCounter, 0),
});

const Store = types
  .model("Store", {
    hits: types.optional(AutomergeCounter, 0),
    todos: types.array(Todo),
    counts: types.map(AutomergeCounter),
  })
  .actions((self) => ({
    run(fn: (s: typeof self) => void) {
      fn(self);
    },
  }));

let repos: Repo[] = [];

afterEach(async () => {
  for (const repo of repos) await repo.shutdown();
  repos = [];
});

async function makeBound(initialSnapshot: any = {}) {
  const repo = new Repo({ network: [] });
  repos.push(repo);
  const handle = repo.create<any>();
  const binding = await bindMSTToAutomerge({
    type: Store,
    handle,
    initialSnapshot,
  });
  return { handle, node: binding.node };
}

async function makeConnectedPair(initialSnapshot: any = {}) {
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
  const a = await bindMSTToAutomerge({
    type: Store,
    handle: handleA,
    initialSnapshot,
  });
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
  await new Promise((r) => setTimeout(r, 10));
}

describe("AutomergeCounter standalone (no binding)", () => {
  it("increments and decrements as a plain MST model", () => {
    const c = AutomergeCounter.create(5);
    c.increment();
    c.increment(3);
    c.decrement(2);
    expect(c.value).toBe(7);
  });

  it("snapshots as a raw number", () => {
    const store = Store.create({ hits: 5 });
    expect(getSnapshot(store).hits).toBe(5);
    store.run((s) => s.hits.increment(2));
    expect(getSnapshot(store).hits).toBe(7);
  });
});

describe("AutomergeCounter bound", () => {
  it("bootstraps counter fields as Counter instances in the doc", async () => {
    const { handle } = await makeBound({
      hits: 3,
      todos: [{ title: "a", votes: 1 }],
      counts: { clicks: 10 },
    });
    const doc = handle.doc();
    expect(doc.hits).toBeInstanceOf(A.Counter);
    expect(doc.hits.value).toBe(3);
    expect(doc.todos[0].votes).toBeInstanceOf(A.Counter);
    expect(doc.counts.clicks).toBeInstanceOf(A.Counter);
  });

  it("emits inc operations for increments, not value puts", async () => {
    const { handle, node } = await makeBound({ hits: 0 });
    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));

    node.run((s) => s.hits.increment(3));
    expect(handle.doc().hits.value).toBe(3);
    expect(patches).toContainEqual({ action: "inc", path: ["hits"], value: 3 });
    expect(patches.filter((p) => p.action === "put")).toEqual([]);

    node.run((s) => s.hits.decrement());
    expect(handle.doc().hits.value).toBe(2);
    expect(patches).toContainEqual({
      action: "inc",
      path: ["hits"],
      value: -1,
    });
  });

  it("translates applySnapshot counter changes into deltas", async () => {
    const { handle, node } = await makeBound({ hits: 5 });
    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));

    applySnapshot(node, { hits: 9 });
    expect(handle.doc().hits).toBeInstanceOf(A.Counter);
    expect(handle.doc().hits.value).toBe(9);
    expect(patches).toContainEqual({ action: "inc", path: ["hits"], value: 4 });
  });

  it("converts counters inside objects pushed while bound", async () => {
    const { handle, node } = await makeBound({});
    node.run((s) => s.todos.push({ title: "new", votes: 2 }));
    expect(handle.doc().todos[0].votes).toBeInstanceOf(A.Counter);
    expect(handle.doc().todos[0].votes.value).toBe(2);

    node.run((s) => s.todos[0]!.votes.increment(3));
    expect(handle.doc().todos[0].votes.value).toBe(5);
  });

  it("converts counters added to maps while bound, and increments survive", async () => {
    const { handle, node } = await makeBound({});
    node.run((s) => s.counts.set("k", AutomergeCounter.create(1)));
    node.run((s) => s.counts.get("k")!.increment(4));
    expect(handle.doc().counts.k).toBeInstanceOf(A.Counter);
    expect(handle.doc().counts.k.value).toBe(5);
  });

  it("applies remote increments reactively", async () => {
    const { handle, node } = await makeBound({ hits: 10 });
    const seen: number[] = [];
    const stop = autorun(() => seen.push(node.hits.value));

    handle.change((d: any) => d.hits.increment(7));
    expect(node.hits.value).toBe(17);
    expect(seen).toEqual([10, 17]);
    stop();
  });
});

describe("AutomergeCounter convergence", () => {
  it("merges concurrent increments additively (the test a plain number fails)", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makeConnectedPair({
      hits: 0,
    });
    nodeA.run((s) => s.hits.increment(2));
    nodeB.run((s) => s.hits.increment(3));
    await settle(handleA, handleB);

    expect(nodeA.hits.value).toBe(5);
    expect(nodeB.hits.value).toBe(5);
    expect(handleA.doc().hits.value).toBe(5);
    expect(docToSnapshot(handleA.doc())).toEqual(docToSnapshot(handleB.doc()));
  });

  it("converges counters nested in concurrently-edited objects", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makeConnectedPair({
      todos: [{ title: "t", votes: 0 }],
    });
    nodeA.run((s) => s.todos[0]!.votes.increment(1));
    nodeA.run((s) => s.todos[0]!.votes.increment(1));
    nodeB.run((s) => s.todos[0]!.votes.increment(5));
    await settle(handleA, handleB);

    expect(nodeA.todos[0]!.votes.value).toBe(7);
    expect(nodeB.todos[0]!.votes.value).toBe(7);
  });
});

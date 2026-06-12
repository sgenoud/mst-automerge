import { afterEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { autorun } from "mobx";
import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import { bindMSTToAutomerge } from "../src/bind";
import { docToSnapshot } from "../src/convert";
import { AutomergeText } from "../src/primitives/text";

const Note = types.model("Note", {
  body: types.optional(AutomergeText, ""),
});

const Store = types
  .model("Store", {
    title: types.optional(AutomergeText, ""),
    notes: types.array(Note),
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

describe("AutomergeText standalone (no binding)", () => {
  it("supports insert, delete and set as a plain MST model", () => {
    const t = AutomergeText.create("hello");
    t.insert(5, " world");
    expect(t.value).toBe("hello world");
    t.delete(0, 6);
    expect(t.value).toBe("world");
    t.set("reset");
    expect(t.value).toBe("reset");
    expect(t.length).toBe(5);
  });

  it("snapshots as a raw string", () => {
    const store = Store.create({ title: "hi" });
    expect(getSnapshot(store).title).toBe("hi");
    store.run((s) => s.title.insert(2, "!"));
    expect(getSnapshot(store).title).toBe("hi!");
  });
});

describe("AutomergeText bound", () => {
  it("emits a minimal splice for insert, not a whole-string rewrite", async () => {
    const { handle, node } = await makeBound({ title: "hello world" });
    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));

    node.run((s) => s.title.insert(6, "brave "));
    expect(handle.doc().title).toBe("hello brave world");
    expect(patches).toContainEqual({
      action: "splice",
      path: ["title", 6],
      value: "brave ",
    });
    expect(patches.filter((p) => p.action === "put")).toEqual([]);
  });

  it("emits del for deletions", async () => {
    const { handle, node } = await makeBound({ title: "hello brave world" });
    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));

    node.run((s) => s.title.delete(6, 6));
    expect(handle.doc().title).toBe("hello world");
    expect(patches).toContainEqual({
      action: "del",
      path: ["title", 6],
      length: 6,
    });
  });

  it("diffs set() and applySnapshot into minimal edits", async () => {
    const { handle, node } = await makeBound({ title: "hello world" });
    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));

    node.run((s) => s.title.set("hello there world"));
    expect(handle.doc().title).toBe("hello there world");
    expect(patches).toContainEqual({
      action: "splice",
      path: ["title", 6],
      value: "there ",
    });

    patches.length = 0;
    applySnapshot(node, { title: "hello world", notes: [] });
    expect(handle.doc().title).toBe("hello world");
    expect(patches).toContainEqual({
      action: "del",
      path: ["title", 6],
      length: 6,
    });
  });

  it("keeps text in pushed objects as native strings, spliceable afterwards", async () => {
    const { handle, node } = await makeBound({});
    node.run((s) => s.notes.push({ body: "draft" }));
    expect(handle.doc().notes[0].body).toBe("draft");

    const patches: A.Patch[] = [];
    handle.on("change", (p: any) => patches.push(...p.patches));
    node.run((s) => s.notes[0]!.body.insert(5, "!"));
    expect(handle.doc().notes[0].body).toBe("draft!");
    expect(patches).toContainEqual({
      action: "splice",
      path: ["notes", 0, "body", 5],
      value: "!",
    });
  });

  it("applies remote splices reactively", async () => {
    const { handle, node } = await makeBound({ title: "hello" });
    const seen: string[] = [];
    const stop = autorun(() => seen.push(node.title.value));

    handle.change((d: any) => A.splice(d, ["title"], 5, 0, " world"));
    expect(node.title.value).toBe("hello world");
    expect(seen).toEqual(["hello", "hello world"]);
    stop();
  });
});

describe("AutomergeText convergence", () => {
  it("interleaves concurrent edits at different positions (the test a plain string fails)", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makeConnectedPair({
      title: "Hello world",
    });
    nodeA.run((s) => s.title.insert(0, "Oh, "));
    nodeB.run((s) => s.title.insert(11, "!"));
    await settle(handleA, handleB);

    expect(nodeA.title.value).toBe("Oh, Hello world!");
    expect(nodeB.title.value).toBe("Oh, Hello world!");
    expect(docToSnapshot(handleA.doc())).toEqual(docToSnapshot(handleB.doc()));
  });

  it("converges concurrent edits around astral characters without corruption", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makeConnectedPair({
      title: "hi 😀 there",
    });
    // "hi 😀" is 5 UTF-16 units; automerge indexes match JS string indices
    nodeA.run((s) => s.title.insert(5, "😀"));
    nodeB.run((s) => s.title.insert(0, "oh "));
    await settle(handleA, handleB);

    expect(nodeA.title.value).toBe(nodeB.title.value);
    expect(nodeA.title.value).toBe("oh hi 😀😀 there");
    // no lone surrogates anywhere
    expect(nodeA.title.value).toBe([...nodeA.title.value].join(""));
  });

  it("converges interleaved sequential edits on both sides", async () => {
    const { handleA, handleB, nodeA, nodeB } = await makeConnectedPair({
      title: "abc",
    });
    nodeA.run((s) => s.title.insert(3, "d"));
    nodeA.run((s) => s.title.delete(0, 1));
    nodeB.run((s) => s.title.set("abcZ"));
    await settle(handleA, handleB);

    expect(nodeA.title.value).toBe(nodeB.title.value);
    expect(docToSnapshot(handleA.doc())).toEqual(docToSnapshot(handleB.doc()));
  });
});

import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { docToSnapshot, snapshotToDoc } from "../src/convert";

const fixture = {
  title: "groceries 🛒",
  count: 3,
  done: false,
  note: null,
  tags: ["food", "週末", "errands"],
  todos: [
    { title: "milk", done: true, meta: { priority: 1, labels: [] } },
    {
      title: "naïve café ☕",
      done: false,
      meta: { priority: 2, labels: ["a", "b"] },
    },
  ],
  settings: { theme: "dark", nested: { deep: { ok: true } } },
};

describe("snapshotToDoc / docToSnapshot", () => {
  it("round-trips a representative snapshot through a raw document", () => {
    const doc = A.change(A.init<any>(), (d) => snapshotToDoc(fixture, d));
    expect(docToSnapshot(doc)).toEqual(fixture);
  });

  it("round-trips through a repo-managed handle", async () => {
    const repo = new Repo({ network: [] });
    const handle = repo.create<any>();
    handle.change((d: any) => snapshotToDoc(fixture, d));
    expect(docToSnapshot(await handle.doc())).toEqual(fixture);
  });

  it("skips undefined object properties instead of throwing", () => {
    const doc = A.change(A.init<any>(), (d) =>
      snapshotToDoc(
        { a: 1, gone: undefined, nested: { x: undefined, y: 2 } },
        d,
      ),
    );
    expect(docToSnapshot(doc)).toEqual({ a: 1, nested: { y: 2 } });
  });

  it("rejects undefined inside arrays (no valid Automerge representation)", () => {
    expect(() =>
      A.change(A.init<any>(), (d) => snapshotToDoc({ list: [1, undefined, 3] }, d)),
    ).toThrow(/undefined/);
  });

  it("rejects non-object roots (the Automerge root is always a map)", () => {
    expect(() =>
      A.change(A.init<any>(), (d) => snapshotToDoc([1, 2] as any, d)),
    ).toThrow();
    expect(() =>
      A.change(A.init<any>(), (d) => snapshotToDoc("nope" as any, d)),
    ).toThrow();
    expect(() =>
      A.change(A.init<any>(), (d) => snapshotToDoc(null as any, d)),
    ).toThrow();
  });

  it("unwraps Counter instances to plain numbers, at any depth", () => {
    const doc = A.change(A.init<any>(), (d) => {
      d.votes = new A.Counter(5);
      d.stats = { clicks: new A.Counter(-2), plain: 7 };
    });
    expect(docToSnapshot(doc)).toEqual({
      votes: 5,
      stats: { clicks: -2, plain: 7 },
    });
  });

  it("returns plain mutable JSON, detached from the document", () => {
    const doc = A.change(A.init<any>(), (d) => snapshotToDoc({ a: { b: [1] } }, d));
    const snap = docToSnapshot(doc) as any;
    snap.a.b.push(2);
    expect(snap.a.b).toEqual([1, 2]);
    expect((doc as any).a.b).toEqual([1]);
  });
});

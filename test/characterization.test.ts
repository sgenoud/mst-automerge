/**
 * Characterization tests: these pin Automerge behavior that the binding
 * relies on. They test Automerge, not our code — if one fails after a
 * dependency upgrade, the translators in src/ need reviewing.
 */
import { describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import type { Patch } from "@automerge/automerge";

function changeWithPatches<T>(
  doc: A.Doc<T>,
  fn: (d: T) => void,
): { doc: A.Doc<T>; patches: Patch[] } {
  const patches: Patch[] = [];
  const next = A.change(doc, { patchCallback: (p) => patches.push(...p) }, fn);
  return { doc: next, patches };
}

function makeDoc(): A.Doc<any> {
  return A.change(A.init<any>(), (d) => {
    d.obj = { a: 1, b: [1, 2], s: "hi" };
  });
}

describe("automerge patch shapes", () => {
  it("decomposes a nested object put into container puts, key puts, insert and splice", () => {
    const { patches } = changeWithPatches(A.init<any>(), (d) => {
      d.obj = { a: 1, b: [1, 2], s: "hi" };
    });
    expect(patches).toEqual([
      { action: "put", path: ["obj"], value: {} },
      { action: "put", path: ["obj", "a"], value: 1 },
      { action: "put", path: ["obj", "b"], value: [] },
      { action: "put", path: ["obj", "s"], value: "" },
      { action: "insert", path: ["obj", "b", 0], values: [1, 2] },
      // strings are text CRDTs: content arrives as a splice, not in the put
      { action: "splice", path: ["obj", "s", 0], value: "hi" },
    ]);
  });

  it("emits insert with a `values` array for list push and insertAt", () => {
    const { doc, patches } = changeWithPatches(makeDoc(), (d) => {
      d.obj.b.push(3);
    });
    expect(patches).toEqual([
      { action: "insert", path: ["obj", "b", 2], values: [3] },
    ]);

    const { patches: multi } = changeWithPatches(doc, (d) => {
      d.obj.b.insertAt(1, 9, 10);
    });
    expect(multi).toEqual([
      { action: "insert", path: ["obj", "b", 1], values: [9, 10] },
    ]);
  });

  it("emits del without length for a single list element", () => {
    const { patches } = changeWithPatches(makeDoc(), (d) => {
      d.obj.b.splice(1, 1);
    });
    expect(patches).toEqual([{ action: "del", path: ["obj", "b", 1] }]);
  });

  it("emits del for a map key", () => {
    const { patches } = changeWithPatches(makeDoc(), (d) => {
      delete d.obj.a;
    });
    expect(patches).toEqual([{ action: "del", path: ["obj", "a"] }]);
  });

  it("emits splice/del-with-length for text edits", () => {
    const { doc, patches } = changeWithPatches(makeDoc(), (d) => {
      A.splice(d, ["obj", "s"], 1, 0, "ello, h");
    });
    expect(patches).toEqual([
      { action: "splice", path: ["obj", "s", 1], value: "ello, h" },
    ]);
    expect(doc.obj.s).toBe("hello, hi");

    const { patches: delPatches } = changeWithPatches(doc, (d) => {
      A.splice(d, ["obj", "s"], 0, 2);
    });
    expect(delPatches).toEqual([
      { action: "del", path: ["obj", "s", 0], length: 2 },
    ]);
  });

  it("patches a Counter creation as a put whose value IS a Counter instance", () => {
    const { doc, patches } = changeWithPatches(A.init<any>(), (d) => {
      d.count = new A.Counter(5);
    });
    // The inbound translator can detect counters directly from the patch
    // value — no doc lookup needed. (Beware: JSON.stringify flattens it.)
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ action: "put", path: ["count"] });
    expect((patches[0] as any).value).toBeInstanceOf(A.Counter);
    expect((patches[0] as any).value.value).toBe(5);
    expect(doc.count).toBeInstanceOf(A.Counter);
  });

  it("emits inc for Counter.increment and reads back as a Counter instance", () => {
    const base = A.change(A.init<any>(), (d) => {
      d.count = new A.Counter(5);
    });
    const { doc, patches } = changeWithPatches(base, (d) => {
      d.count.increment(3);
    });
    expect(patches).toEqual([{ action: "inc", path: ["count"], value: 3 }]);
    expect(doc.count.value).toBe(8);
    expect(JSON.parse(JSON.stringify(doc))).toEqual({ count: 8 });
  });

  it("puts null but throws on undefined assignment", () => {
    const { patches } = changeWithPatches(A.init<any>(), (d) => {
      d.n = null;
    });
    expect(patches).toEqual([{ action: "put", path: ["n"], value: null }]);

    expect(() =>
      A.change(A.init<any>(), (d) => {
        d.u = undefined;
      }),
    ).toThrow(RangeError);
  });
});

/**
 * Characterization tests: pin the MST patch shapes the outbound translator
 * relies on. They test mobx-state-tree, not our code — if one fails after a
 * dependency upgrade, src/outbound.ts needs reviewing.
 */
import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  type IJsonPatch,
  onPatch,
  types,
} from "mobx-state-tree";

const Store = types
  .model("Store", {
    arr: types.array(types.number),
    map: types.map(types.number),
    maybe: types.maybe(types.string),
    title: "hi",
  })
  .actions((self) => ({
    run(fn: (s: typeof self) => void) {
      fn(self);
    },
  }));

function record(fn: (s: any) => void): IJsonPatch[] {
  const store = Store.create({
    arr: [1, 2, 3, 4],
    map: { x: 1 },
    maybe: "yes",
  });
  const patches: IJsonPatch[] = [];
  onPatch(store, (p) => patches.push(p));
  store.run(fn);
  return patches;
}

describe("mst patch shapes", () => {
  it("emits indexed add for push, unshift and mid-array splice (insert intent survives)", () => {
    expect(record((s) => s.arr.push(5))).toEqual([
      { op: "add", path: "/arr/4", value: 5 },
    ]);
    expect(record((s) => s.arr.unshift(0))).toEqual([
      { op: "add", path: "/arr/0", value: 0 },
    ]);
    expect(record((s) => s.arr.splice(2, 0, 99))).toEqual([
      { op: "add", path: "/arr/2", value: 99 },
    ]);
  });

  it("emits indexed remove for splice deletion and pop", () => {
    expect(record((s) => s.arr.splice(2, 1))).toEqual([
      { op: "remove", path: "/arr/2" },
    ]);
    expect(record((s) => s.arr.pop())).toEqual([
      { op: "remove", path: "/arr/3" },
    ]);
  });

  it("decomposes a replacing splice into removes (descending) then adds (ascending)", () => {
    expect(record((s) => s.arr.splice(1, 2, 7, 8, 9))).toEqual([
      { op: "remove", path: "/arr/2" },
      { op: "remove", path: "/arr/1" },
      { op: "add", path: "/arr/1", value: 7 },
      { op: "add", path: "/arr/2", value: 8 },
      { op: "add", path: "/arr/3", value: 9 },
    ]);
  });

  it("emits replace for in-place index assignment and whole-array assignment", () => {
    expect(record((s) => (s.arr[0] = 100))).toEqual([
      { op: "replace", path: "/arr/0", value: 100 },
    ]);
    expect(record((s) => (s.arr = [1] as any))).toEqual([
      { op: "replace", path: "/arr", value: [1] },
    ]);
  });

  it("emits add/replace/remove for map mutations", () => {
    expect(record((s) => s.map.set("y", 2))).toEqual([
      { op: "add", path: "/map/y", value: 2 },
    ]);
    expect(record((s) => s.map.set("x", 10))).toEqual([
      { op: "replace", path: "/map/x", value: 10 },
    ]);
    expect(record((s) => s.map.delete("x"))).toEqual([
      { op: "remove", path: "/map/x" },
    ]);
  });

  it("emits replace with value: undefined when an optional becomes undefined", () => {
    const patches = record((s) => (s.maybe = undefined));
    expect(patches).toEqual([{ op: "replace", path: "/maybe" }]);
    // the key IS present, holding undefined (JSON.stringify would hide it);
    // the outbound translator must turn this into a map-key delete
    expect("value" in patches[0]!).toBe(true);
    expect((patches[0] as any).value).toBeUndefined();
  });

  it("decomposes applySnapshot into per-field patches (never one root replace)", () => {
    const patches = record((s) =>
      applySnapshot(s, { arr: [42], map: {}, title: "snap" }),
    );
    expect(patches).toEqual([
      { op: "replace", path: "/arr", value: [42] },
      { op: "remove", path: "/map/x" },
      { op: "replace", path: "/maybe" },
      { op: "replace", path: "/title", value: "snap" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { amPathToMst, mstPathToAm } from "../src/paths";

describe("mstPathToAm", () => {
  it("converts the root path to an empty path array", () => {
    expect(mstPathToAm("")).toEqual([]);
  });

  it("converts a nested path, turning list indices into numbers", () => {
    expect(mstPathToAm("/todos/0/title")).toEqual(["todos", 0, "title"]);
    expect(mstPathToAm("/a/12/b/3")).toEqual(["a", 12, "b", 3]);
  });

  it("keeps plain keys as strings", () => {
    expect(mstPathToAm("/settings/theme")).toEqual(["settings", "theme"]);
  });

  it("unescapes JSON-pointer escapes (~1 -> /, ~0 -> ~)", () => {
    expect(mstPathToAm("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    // order matters: "~01" must decode to "~1", not "/"
    expect(mstPathToAm("/x~01")).toEqual(["x~1"]);
  });

  it("only treats canonical non-negative integers as indices", () => {
    expect(mstPathToAm("/m/01")).toEqual(["m", "01"]);
    expect(mstPathToAm("/m/1.5")).toEqual(["m", "1.5"]);
    expect(mstPathToAm("/m/-1")).toEqual(["m", "-1"]);
    expect(mstPathToAm("/m/1e2")).toEqual(["m", "1e2"]);
  });

  it("rejects paths that do not start with a slash", () => {
    expect(() => mstPathToAm("todos/0")).toThrow();
  });
});

describe("amPathToMst", () => {
  it("converts the empty path array to the root path", () => {
    expect(amPathToMst([])).toBe("");
  });

  it("converts a nested path", () => {
    expect(amPathToMst(["todos", 0, "title"])).toBe("/todos/0/title");
  });

  it("escapes / and ~ in keys", () => {
    expect(amPathToMst(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    expect(amPathToMst(["x~1"])).toBe("/x~01");
  });

  it("treats numeric string keys the same as numbers (lossy, by design)", () => {
    // An Automerge map key "0" and a list index 0 produce the same MST path;
    // MST itself addresses both maps and arrays with string segments.
    expect(amPathToMst(["m", "0"])).toBe("/m/0");
  });
});

describe("round trips", () => {
  it.each(["", "/todos/0/title", "/a~1b/c~0d", "/deep/1/list/22/key", "/x~01"])(
    "mst -> am -> mst preserves %j",
    (path) => {
      expect(amPathToMst(mstPathToAm(path))).toBe(path);
    },
  );

  it("am -> mst -> am preserves typed paths", () => {
    const path = ["todos", 0, "a/b", 3, "c~d"];
    expect(mstPathToAm(amPathToMst(path))).toEqual(path);
  });
});

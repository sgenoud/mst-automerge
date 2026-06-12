import { describe, expect, it } from "vitest";
import { getSnapshot, types } from "mobx-state-tree";
import * as Automerge from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";

describe("environment smoke", () => {
  it("creates and mutates an MST tree", () => {
    const Todo = types
      .model("Todo", { title: types.string, done: false })
      .actions((self) => ({
        toggle() {
          self.done = !self.done;
        },
      }));

    const todo = Todo.create({ title: "write adapter" });
    todo.toggle();
    expect(getSnapshot(todo)).toEqual({ title: "write adapter", done: true });
  });

  it("creates and changes an Automerge document", () => {
    type Doc = { todos: { title: string; done: boolean }[] };
    let doc = Automerge.from<Doc>({ todos: [] });
    doc = Automerge.change(doc, (d) => {
      d.todos.push({ title: "write adapter", done: false });
    });
    expect(doc.todos).toHaveLength(1);
    expect(doc.todos[0]!.title).toBe("write adapter");
  });

  it("creates a repo-managed document handle", async () => {
    type Doc = { count: number };
    const repo = new Repo({ network: [] });
    const handle = repo.create<Doc>({ count: 0 });
    handle.change((d) => {
      d.count = 1;
    });
    const doc = await handle.doc();
    expect(doc.count).toBe(1);
  });
});

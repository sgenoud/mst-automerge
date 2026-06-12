import {
  getType,
  isStateTreeNode,
  types,
  type Instance,
} from "mobx-state-tree";

const TEXT_TYPE_NAME = "AutomergeText";

const TextBase = types
  .model(TEXT_TYPE_NAME, { value: "" })
  .views((self) => ({
    get length() {
      return self.value.length;
    },
  }))
  .actions((self) => ({
    insert(index: number, text: string) {
      self.value = self.value.slice(0, index) + text + self.value.slice(index);
    },
    delete(index: number, count = 1) {
      self.value = self.value.slice(0, index) + self.value.slice(index + count);
    },
    set(text: string) {
      self.value = text;
    },
  }));

/**
 * Collaborative text as an MST node. Snapshots as a raw string; in the
 * bound Automerge document it lives as a native text CRDT (all Automerge
 * strings are), so concurrent edits at different positions interleave
 * instead of last-writer-wins.
 *
 * The binding routes ANY change to `value` through `Automerge.updateText`,
 * which diffs old vs new text into minimal splices — so `insert`/`delete`,
 * `set`, and `applySnapshot` all preserve concurrent edits.
 *
 * Indices are UTF-16 code units, identical to JS string indexing
 * (characterized in test/text.test.ts; Automerge snaps indices that would
 * split a surrogate pair).
 */
export const AutomergeText = types.snapshotProcessor(
  TextBase,
  {
    preProcessor(snapshot: string | { value: string }) {
      return typeof snapshot === "string" ? { value: snapshot } : snapshot;
    },
    postProcessor(snapshot): string {
      return snapshot.value;
    },
  },
  TEXT_TYPE_NAME,
);

export type AutomergeTextInstance = Instance<typeof TextBase>;

export function isAutomergeText(
  value: unknown,
): value is AutomergeTextInstance {
  return isStateTreeNode(value) && getType(value).name === TEXT_TYPE_NAME;
}

import { Counter } from "@automerge/automerge";
import {
  getType,
  isArrayType,
  isMapType,
  isModelType,
  isStateTreeNode,
  types,
  type Instance,
} from "mobx-state-tree";
import type { AmPath } from "../paths";

const COUNTER_TYPE_NAME = "AutomergeCounter";

const CounterBase = types
  .model(COUNTER_TYPE_NAME, { value: 0 })
  .actions((self) => ({
    increment(by = 1) {
      self.value += by;
    },
    decrement(by = 1) {
      self.value -= by;
    },
  }));

/**
 * A CRDT counter as an MST node. Snapshots as a raw number; in the bound
 * Automerge document it is stored as an `Automerge.Counter`, so concurrent
 * increments merge additively instead of last-writer-wins.
 *
 * The binding translates ANY change to `value` into an increment by the
 * delta (the reverse patch supplies the old value), so `applySnapshot`
 * also merges additively rather than resetting the counter.
 */
export const AutomergeCounter = types.snapshotProcessor(
  CounterBase,
  {
    preProcessor(snapshot: number | { value: number }) {
      return typeof snapshot === "number" ? { value: snapshot } : snapshot;
    },
    postProcessor(snapshot): number {
      return snapshot.value;
    },
  },
  COUNTER_TYPE_NAME,
);

export type AutomergeCounterInstance = Instance<typeof CounterBase>;

export function isAutomergeCounter(
  value: unknown,
): value is AutomergeCounterInstance {
  return isStateTreeNode(value) && getType(value).name === COUNTER_TYPE_NAME;
}

/**
 * Find all AutomergeCounter instances in a subtree, with their paths
 * relative to `value`. Does not see through user-defined snapshot
 * processors (their inner structure is not introspectable).
 */
export function collectCounterPaths(
  value: unknown,
  base: AmPath = [],
): { path: AmPath; value: number }[] {
  const out: { path: AmPath; value: number }[] = [];
  const visit = (v: unknown, path: AmPath) => {
    if (!isStateTreeNode(v)) return;
    if (isAutomergeCounter(v)) {
      out.push({ path, value: v.value });
      return;
    }
    const type = getType(v);
    if (isModelType(type)) {
      for (const key of Object.keys(type.properties)) {
        visit((v as any)[key], [...path, key]);
      }
    } else if (isArrayType(type)) {
      (v as any).forEach((item: unknown, i: number) =>
        visit(item, [...path, i]),
      );
    } else if (isMapType(type)) {
      (v as any).forEach((item: unknown, key: string) =>
        visit(item, [...path, String(key)]),
      );
    }
  };
  visit(value, base);
  return out;
}

/** Overwrite the value at `path` in a change proxy with a fresh Counter. */
export function setCounterAt(
  doc: Record<string, unknown>,
  path: AmPath,
  value: number,
): void {
  let parent: any = doc;
  for (const seg of path.slice(0, -1)) parent = parent[seg];
  parent[path[path.length - 1]!] = new Counter(value);
}

/** Read the value at `path` in a doc; undefined if unresolvable. */
export function getAtPath(doc: unknown, path: AmPath): unknown {
  let current: any = doc;
  for (const seg of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[seg];
  }
  return current;
}

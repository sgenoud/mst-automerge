import { updateText } from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import {
  addMiddleware,
  onPatch,
  resolvePath,
  type IAnyStateTreeNode,
  type IJsonPatch,
} from "mobx-state-tree";
import { sanitize } from "./convert";
import { newOrigin, type SyncOrigin } from "./origin";
import { mstPathToAm, type AmPath } from "./paths";
import {
  collectCounterPaths,
  isAutomergeCounter,
  setCounterAt,
} from "./primitives/counter";
import { isAutomergeText } from "./primitives/text";

/**
 * Outbound direction: MST patches -> mutations on an Automerge change proxy.
 *
 * Characterized MST shapes this relies on (see test/mst-characterization):
 * - array splices arrive as indexed add/remove at the splice point
 * - optionals becoming undefined arrive as replace with value === undefined
 * - applySnapshot arrives decomposed into per-field patches
 */
export function applyMstPatchToDoc(
  root: Record<string, unknown>,
  patch: IJsonPatch,
): void {
  const amPath = mstPathToAm(patch.path);
  if (amPath.length === 0) {
    throw new Error(`Unexpected MST patch on the root path: ${patch.op}`);
  }

  let parent: any = root;
  for (const seg of amPath.slice(0, -1)) {
    parent = parent[seg];
    if (parent == null || typeof parent !== "object") {
      throw new Error(`Cannot resolve ${patch.path} in the Automerge document`);
    }
  }
  const key = amPath[amPath.length - 1]!;
  const isList = Array.isArray(parent);

  switch (patch.op) {
    case "add":
      if (isList) {
        parent.insertAt(key as number, sanitize(patch.value, patch.path));
      } else {
        parent[key] = sanitize(patch.value, patch.path);
      }
      break;
    case "replace":
      if (patch.value === undefined) {
        // an optional became undefined; Automerge cannot store undefined
        if (isList) {
          throw new Error(
            `Cannot set list element to undefined at ${patch.path}`,
          );
        }
        delete parent[key];
      } else {
        parent[key] = sanitize(patch.value, patch.path);
      }
      break;
    case "remove":
      if (isList) {
        parent.deleteAt(key as number);
      } else {
        delete parent[key];
      }
      break;
  }
}

/**
 * The outbound buffer holds classified operations, not raw patches:
 * - "patch": a structural patch, plus the paths of any counter wrapper
 *   nodes inside its value (their plain numbers are re-written as Counter
 *   instances right after the patch applies)
 * - "inc": a counter value change, reduced to its delta via the reverse
 *   patch — so increments AND applySnapshot merge additively
 * - "text": a text wrapper value change, applied via Automerge.updateText
 *   so it lands as minimal splices that respect concurrent edits
 *
 * Classification happens inside the onPatch callback, while the mutated
 * nodes are guaranteed to be alive for type resolution.
 */
type OutboundOp =
  | {
      kind: "patch";
      patch: IJsonPatch;
      counters: { path: AmPath; value: number }[];
    }
  | { kind: "inc"; path: AmPath; by: number }
  | { kind: "text"; path: AmPath; value: string };

function tryResolve(node: IAnyStateTreeNode, path: string): unknown {
  try {
    return resolvePath(node, path);
  } catch {
    return undefined;
  }
}

function classify(
  node: IAnyStateTreeNode,
  patch: IJsonPatch,
  reverse: IJsonPatch,
): OutboundOp {
  const slash = patch.path.lastIndexOf("/");
  const lastSegment = patch.path.slice(slash + 1);

  if (patch.op === "replace" && lastSegment === "value") {
    const parentPath = patch.path.slice(0, slash);
    const parent = tryResolve(node, parentPath);
    if (isAutomergeCounter(parent)) {
      return {
        kind: "inc",
        path: mstPathToAm(parentPath),
        by: (patch.value as number) - (reverse.value as number),
      };
    }
    if (isAutomergeText(parent)) {
      return {
        kind: "text",
        path: mstPathToAm(parentPath),
        value: patch.value as string,
      };
    }
  }

  if (patch.op === "add" || patch.op === "replace") {
    const target = tryResolve(node, patch.path);
    const base = mstPathToAm(patch.path);
    const counters = collectCounterPaths(target, base);
    return { kind: "patch", patch, counters };
  }

  return { kind: "patch", patch, counters: [] };
}

/**
 * One-way binding: every MST mutation on `node` is replayed into `handle`.
 * All patches of one top-level action flush as a single Automerge change.
 * Returns a disposer.
 */
export function bindOutbound(
  node: IAnyStateTreeNode,
  handle: DocHandle<unknown>,
  origin: SyncOrigin = newOrigin(),
): () => void {
  let buffer: OutboundOp[] = [];
  let flushQueued = false;

  const flush = () => {
    if (buffer.length === 0) return;
    const ops = buffer;
    buffer = [];
    origin.local = true;
    try {
      handle.change((doc) => {
        const root = doc as Record<string, unknown>;
        for (const op of ops) {
          if (op.kind === "inc") {
            let target: any = root;
            for (const seg of op.path) target = target[seg];
            target.increment(op.by);
          } else if (op.kind === "text") {
            updateText(root, op.path, op.value);
          } else {
            applyMstPatchToDoc(root, op.patch);
            for (const counter of op.counters) {
              setCounterAt(root, counter.path, counter.value);
            }
          }
        }
      });
    } finally {
      origin.local = false;
    }
  };

  const disposeOnPatch = onPatch(node, (patch, reverse) => {
    if (origin.remote) return; // the inbound binding is applying this
    buffer.push(classify(node, patch, reverse));
    // Safety net for mutations outside middleware reach (e.g. unprotected
    // trees, flow continuations): flush on the microtask if still pending.
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(() => {
        flushQueued = false;
        flush();
      });
    }
  });

  // Flush synchronously when the top-level action completes, so one action
  // becomes exactly one Automerge change (and one sync message).
  const disposeMiddleware = addMiddleware(node, (call, next) => {
    if (call.parentActionEvent) return next(call);
    try {
      return next(call);
    } finally {
      flush();
    }
  });

  return () => {
    disposeOnPatch();
    disposeMiddleware();
    flush();
  };
}

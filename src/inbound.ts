import type { Patch } from "@automerge/automerge";
import { Counter } from "@automerge/automerge";
import type {
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo";
import { runInAction } from "mobx";
import {
  applyPatch,
  applySnapshot,
  getSnapshot,
  getType,
  isMapType,
  isStateTreeNode,
  resolvePath,
  type IAnyStateTreeNode,
  type IJsonPatch,
} from "mobx-state-tree";
import { docToSnapshot } from "./convert";
import { newOrigin, type SyncOrigin } from "./origin";
import { amPathToMst, type AmPath } from "./paths";
import { isAutomergeCounter } from "./primitives/counter";
import { isAutomergeText } from "./primitives/text";

/**
 * Inbound direction: Automerge patches -> a live MST tree.
 *
 * Two application strategies:
 *
 * FAST PATH — when no patch in the event grafts a container. Each patch
 * translates to an MST patch applied immediately, O(change). This covers
 * the high-frequency cases: typing, toggles, increments, list edits of
 * primitives.
 *
 * SHADOW PATH — when the event grafts objects/arrays. Sync-received change
 * events carry DIFF-derived patch streams whose ordering interleaves
 * objects arbitrarily: a new object arrives as an empty-container insert
 * whose fill patches may come AFTER unrelated patches (characterized in
 * M6). Applying such intermediates to MST violates type checks (`{}` is
 * not a `Todo`). So the whole batch replays into a plain-JS shadow copy of
 * the tree's snapshot — type-free, order-tolerant — applied back in one
 * applySnapshot; MST reconciliation keeps node identity for unchanged
 * subtrees. O(tree), accepted for the rarer structural events.
 *
 * Other characterized shapes handled here (see test/characterization):
 * - string content always arrives as splice/del-with-length text patches
 *   addressed at character indices inside the string (UTF-16 code units,
 *   same as JS strings)
 * - a put value can be a Counter instance; docToSnapshot unwraps it
 * - conflict/mark/unmark are CRDT metadata; value effects arrive as puts
 */

const spliceStr = (s: string, idx: number, ins: string, del = 0): string =>
  s.slice(0, idx) + ins + s.slice(idx + del);

const isContainerValue = (v: unknown): boolean =>
  v !== null &&
  typeof v === "object" &&
  !(v instanceof Counter) &&
  !(v instanceof Uint8Array);

const isMetadata = (p: Patch): boolean =>
  p.action === "conflict" || p.action === "mark" || p.action === "unmark";

const isSimplePatch = (p: Patch): boolean => {
  switch (p.action) {
    case "put":
      return !isContainerValue(p.value);
    case "insert":
      return p.values.every((v) => !isContainerValue(v));
    default:
      return true;
  }
};

export function applyAmPatchesToNode(
  node: IAnyStateTreeNode,
  patches: Patch[],
): void {
  if (patches.length === 0) return;
  const applicable = patches.filter((p) => !isMetadata(p));
  if (applicable.every(isSimplePatch)) {
    runInAction(() => {
      for (const patch of applicable) applySimplePatch(node, patch);
    });
  } else {
    let shadow: unknown = JSON.parse(JSON.stringify(getSnapshot(node)));
    for (const patch of applicable) {
      shadow = applyToShadow(shadow, patch.path, patch);
    }
    applySnapshot(node, shadow);
  }
}

// ---------------------------------------------------------------- fast path

function resolveLive(node: IAnyStateTreeNode, path: AmPath): unknown {
  return resolvePath(node, amPathToMst(path));
}

/** The string content of a live target, whether a plain string field or an
 * AutomergeText wrapper; undefined if it is neither. */
function liveString(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (isAutomergeText(target)) return target.value;
  return undefined;
}

function isMapNode(target: unknown): boolean {
  return isStateTreeNode(target) && isMapType(getType(target));
}

function applySimplePatch(node: IAnyStateTreeNode, patch: Patch): void {
  const path = patch.path;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;

  switch (patch.action) {
    case "put": {
      const parent = resolveLive(node, parentPath);
      const op: IJsonPatch["op"] =
        isMapNode(parent) && !(parent as any).has(String(last))
          ? "add"
          : "replace";
      applyPatch(node, {
        op,
        path: amPathToMst(path),
        value: docToSnapshot(patch.value),
      });
      break;
    }

    case "insert": {
      const idx = last as number;
      const adds = patch.values.map((value, k) => ({
        op: "add" as const,
        path: amPathToMst([...parentPath, idx + k]),
        value: docToSnapshot(value),
      }));
      if (adds.length > 0) applyPatch(node, adds);
      break;
    }

    case "splice": {
      // text insertion: parentPath addresses the string itself
      const current = liveString(resolveLive(node, parentPath));
      if (current === undefined) {
        throw new Error(
          `Text splice targets a non-string at ${amPathToMst(parentPath)}`,
        );
      }
      applyPatch(node, {
        op: "replace",
        path: amPathToMst(parentPath),
        value: spliceStr(current, last as number, patch.value),
      });
      break;
    }

    case "del": {
      const parent = resolveLive(node, parentPath);
      const text = liveString(parent);
      if (text !== undefined) {
        applyPatch(node, {
          op: "replace",
          path: amPathToMst(parentPath),
          value: spliceStr(text, last as number, "", patch.length ?? 1),
        });
      } else if (Array.isArray(parent)) {
        const count = patch.length ?? 1;
        applyPatch(
          node,
          Array.from({ length: count }, () => ({
            op: "remove" as const,
            path: amPathToMst(path),
          })),
        );
      } else if (isMapNode(parent)) {
        applyPatch(node, { op: "remove", path: amPathToMst(path) });
      } else {
        // a model's optional prop had its key deleted
        applyPatch(node, {
          op: "replace",
          path: amPathToMst(path),
          value: undefined,
        });
      }
      break;
    }

    case "inc": {
      const target = resolveLive(node, path);
      const current = isAutomergeCounter(target)
        ? target.value
        : (target as number);
      applyPatch(node, {
        op: "replace",
        path: amPathToMst(path),
        value: current + patch.value,
      });
      break;
    }
  }
}

// -------------------------------------------------------------- shadow path

/** Replay one patch into the plain-JS shadow. Returns the (possibly
 * replaced) shadow — a string root is immutable. */
function applyToShadow(shadow: unknown, rel: AmPath, patch: Patch): unknown {
  if (rel.length === 0) {
    if (patch.action !== "put") {
      throw new Error(`Unexpected ${patch.action} at the shadow root`);
    }
    return docToSnapshot(patch.value);
  }

  const get = (p: AmPath): any => p.reduce((acc: any, seg) => acc[seg], shadow);
  const last = rel[rel.length - 1]!;
  const parentRel = rel.slice(0, -1);
  const parentVal = get(parentRel);
  if (parentVal == null || typeof parentVal !== "object") {
    if (typeof parentVal === "string") {
      // text op: the addressed parent is a string, last is a char index
      const next =
        patch.action === "splice"
          ? spliceStr(parentVal, last as number, patch.value)
          : patch.action === "del"
            ? spliceStr(parentVal, last as number, "", patch.length ?? 1)
            : (() => {
                throw new Error(`Unexpected ${patch.action} inside a string`);
              })();
      if (parentRel.length === 0) return next; // the shadow root IS the string
      get(parentRel.slice(0, -1))[parentRel[parentRel.length - 1]!] = next;
      return shadow;
    }
    throw new Error(
      `Cannot resolve /${rel.join("/")} while replaying a ${patch.action} patch`,
    );
  }

  switch (patch.action) {
    case "put":
      parentVal[last] = docToSnapshot(patch.value);
      break;
    case "insert":
      parentVal.splice(last as number, 0, ...patch.values.map(docToSnapshot));
      break;
    case "del":
      if (Array.isArray(parentVal)) {
        parentVal.splice(last as number, patch.length ?? 1);
      } else {
        delete parentVal[last];
      }
      break;
    case "inc":
      parentVal[last] += patch.value;
      break;
    case "splice":
      // text splices address a char index INSIDE a string, so the string
      // itself is the parent and the branch above handles them
      throw new Error(`Text splice addressed a container at /${rel.join("/")}`);
    default:
      throw new Error(`Unhandled patch action ${(patch as Patch).action}`);
  }
  return shadow;
}

// ----------------------------------------------------------------- binding

/**
 * One-way binding: every change event on `handle` (local or remote) is
 * replayed onto `node`, one MST transaction per event. Returns a disposer.
 *
 * Error handling: DocHandle emits change events through a decoupled state
 * machine, so a throwing listener cannot reach the code that caused the
 * change — it only produces process-level noise. Failures therefore go to
 * `onError` (default: console.error). The tree keeps its last valid state
 * and the binding stays attached; the next applicable change triggers a
 * full resync from the doc.
 */
export function bindInbound(
  node: IAnyStateTreeNode,
  handle: DocHandle<unknown>,
  origin: SyncOrigin = newOrigin(),
  onError: (error: unknown) => void = (error) =>
    console.error(
      "[mst-automerge] failed to apply an inbound change; the tree keeps " +
        "its last valid state and will resync on the next valid change:",
      error,
    ),
): () => void {
  // After a failed event the tree no longer matches the doc, so patch
  // replay (which starts from the tree's snapshot) would be wrong even for
  // valid follow-up events: resync from the full doc until one succeeds.
  let needsResync = false;

  const listener = (payload: DocHandleChangePayload<unknown>) => {
    if (origin.local) return; // this binding's own outbound flush
    origin.remote = true;
    try {
      if (needsResync) {
        applySnapshot(node, docToSnapshot(payload.doc));
        needsResync = false;
      } else {
        applyAmPatchesToNode(node, payload.patches);
      }
    } catch (error) {
      needsResync = true;
      onError(error);
    } finally {
      origin.remote = false;
    }
  };
  handle.on("change", listener);
  return () => {
    handle.off("change", listener);
  };
}

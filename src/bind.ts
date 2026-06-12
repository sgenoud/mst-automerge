import type { DocHandle, Repo } from "@automerge/automerge-repo";
import {
  getSnapshot,
  type IAnyModelType,
  type IAnyStateTreeNode,
  type Instance,
  type SnapshotIn,
} from "mobx-state-tree";
import { Counter } from "@automerge/automerge";
import { docToSnapshot, sanitize, snapshotToDoc } from "./convert";
import { bindInbound } from "./inbound";
import { newOrigin } from "./origin";
import { bindOutbound } from "./outbound";
import {
  collectCounterPaths,
  getAtPath,
  setCounterAt,
} from "./primitives/counter";

export interface MstAutomergeBinding<T extends IAnyModelType> {
  /** The live, two-way-bound MST instance. */
  node: Instance<T>;
  handle: DocHandle<SnapshotIn<T>>;
  /** Detach both directions; node and doc stay usable, just unsynced. */
  dispose: () => void;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Defaults handling: an MST instance built from a sparse doc fills in type
 * defaults that the doc lacks. To keep doc content === tree snapshot, those
 * missing keys (and only those) are written back once at bind time. Writing
 * only missing keys keeps rebinding idempotent and never rewrites text or
 * concurrent values.
 */
function hasMissing(snapshot: unknown, docVal: unknown): boolean {
  if (Array.isArray(snapshot) && Array.isArray(docVal)) {
    return snapshot.some((item, i) => hasMissing(item, docVal[i]));
  }
  if (isPlain(snapshot) && isPlain(docVal)) {
    return Object.entries(snapshot).some(([key, value]) =>
      value === undefined
        ? false
        : key in docVal
          ? hasMissing(value, docVal[key])
          : true,
    );
  }
  return false;
}

function writeMissing(snapshot: unknown, docVal: unknown, proxy: any): void {
  if (Array.isArray(snapshot) && Array.isArray(docVal)) {
    snapshot.forEach((item, i) => writeMissing(item, docVal[i], proxy[i]));
    return;
  }
  if (isPlain(snapshot) && isPlain(docVal)) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) continue;
      if (key in docVal) writeMissing(value, docVal[key], proxy[key]);
      else proxy[key] = sanitize(value, `/${key}`);
    }
  }
}

/**
 * Bind an MST model type to an Automerge document handle, two-way.
 *
 * Bootstrap rules:
 * - empty doc + initialSnapshot: the doc is seeded from the snapshot
 * - non-empty doc: the doc wins; initialSnapshot is ignored (it is a seed,
 *   not a merge input — the doc is the replicated source of truth)
 * - type defaults missing from the doc are written back once
 */
export async function bindMSTToAutomerge<T extends IAnyModelType>(opts: {
  type: T;
  handle: DocHandle<SnapshotIn<T>>;
  /** Used only when the doc has no content yet. */
  initialSnapshot?: SnapshotIn<T>;
  /**
   * Called when an inbound change cannot be applied to the tree (e.g. the
   * doc no longer satisfies the type). The tree keeps its last valid state
   * and resyncs on the next applicable change. Without a handler, the
   * error propagates (fail loudly).
   */
  onSyncError?: (error: unknown) => void;
}): Promise<MstAutomergeBinding<T>> {
  const { type, handle, initialSnapshot, onSyncError } = opts;
  await handle.whenReady();

  const current = docToSnapshot(handle.doc()) as Record<string, unknown>;
  if (Object.keys(current).length === 0 && initialSnapshot != null) {
    handle.change((d) =>
      snapshotToDoc(
        initialSnapshot as Record<string, unknown>,
        d as Record<string, unknown>,
      ),
    );
  }

  let node: Instance<T>;
  try {
    node = type.create(docToSnapshot(handle.doc()) as SnapshotIn<T>);
  } catch (error) {
    throw new Error(
      `[mst-automerge] document ${handle.url} does not satisfy type ` +
        `${type.name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const full = JSON.parse(JSON.stringify(getSnapshot(node))) as Record<
    string,
    unknown
  >;
  const docNow = docToSnapshot(handle.doc());
  if (hasMissing(full, docNow)) {
    handle.change((d) => writeMissing(full, docNow, d));
  }

  // Counter fields bootstrap as plain numbers (snapshots are JSON); convert
  // them to Counter instances once. Already-converted ones are left alone —
  // overwriting would discard their increment history.
  const counters = collectCounterPaths(node).filter(
    ({ path }) => !(getAtPath(handle.doc(), path) instanceof Counter),
  );
  if (counters.length > 0) {
    handle.change((d) => {
      for (const { path, value } of counters) {
        setCounterAt(d as Record<string, unknown>, path, value);
      }
    });
  }

  const origin = newOrigin();
  const disposeOutbound = bindOutbound(node, handle, origin);
  const disposeInbound = bindInbound(node, handle, origin, onSyncError);

  return {
    node: node as Instance<T>,
    handle,
    dispose: () => {
      disposeOutbound();
      disposeInbound();
    },
  };
}

/**
 * Create a fresh doc in `repo` mirroring an existing (possibly unbound)
 * tree, counters included. The handle can be passed to bindMSTToAutomerge
 * later without producing any further bootstrap changes.
 */
export function createDocFromTree(
  repo: Repo,
  node: IAnyStateTreeNode,
): DocHandle<Record<string, unknown>> {
  const handle = repo.create<Record<string, unknown>>();
  const snapshot = JSON.parse(JSON.stringify(getSnapshot(node))) as Record<
    string,
    unknown
  >;
  const counters = collectCounterPaths(node);
  handle.change((d) => {
    snapshotToDoc(snapshot, d);
    for (const { path, value } of counters) {
      setCounterAt(d, path, value);
    }
  });
  return handle;
}

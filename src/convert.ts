import { Counter } from "@automerge/automerge";

/**
 * Conversions between plain JSON snapshots (the MST wire format) and
 * Automerge document content.
 *
 * Type-unaware by design: counter/text placement is driven by the MST type
 * in later layers, not here. `docToSnapshot` unwraps Counter instances to
 * plain numbers; the counter wrapper model owns re-shaping its snapshot.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-copy a snapshot value for writing into a doc, dropping undefined object keys. */
export function sanitize(value: unknown, path: string): unknown {
  if (value === undefined) {
    throw new TypeError(
      `Cannot write undefined to an Automerge document at ${path}; ` +
        `use null or omit the property`,
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Counter) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitize(item, `${path}/${i}`));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = sanitize(item, `${path}/${key}`);
  }
  return result;
}

/**
 * Write a snapshot's properties into a mutable Automerge change proxy.
 * Must be called inside `Automerge.change` / `handle.change`.
 */
export function snapshotToDoc(
  snapshot: Record<string, unknown>,
  doc: Record<string, unknown>,
): void {
  if (!isPlainObject(snapshot)) {
    throw new TypeError(
      "snapshotToDoc requires a plain object snapshot: the Automerge root is always a map",
    );
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) continue;
    doc[key] = sanitize(value, `/${key}`);
  }
}

/** Deep-convert an Automerge document (or subtree) to plain, detached JSON. */
export function docToSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Counter) return value.value;
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(docToSnapshot);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = docToSnapshot(item);
  }
  return result;
}

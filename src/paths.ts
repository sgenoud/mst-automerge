/**
 * Conversions between MST's JSON-pointer paths ("/todos/0/title") and
 * Automerge's path arrays (["todos", 0, "title"]).
 *
 * Canonical non-negative integer segments become numbers. This is lossy for
 * Automerge map keys that look like integers (["m", "0"] and ["m", 0] both
 * render as "/m/0"), which is safe in practice: MST addresses maps and arrays
 * with string segments alike, and JS property access coerces either way.
 */

export type AmPath = (string | number)[];

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function mstPathToAm(path: string): AmPath {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new TypeError(
      `Invalid MST path ${JSON.stringify(path)}: must be "" or start with "/"`,
    );
  }
  return path
    .slice(1)
    .split("/")
    .map((raw) =>
      CANONICAL_INDEX.test(raw) ? Number(raw) : unescapeSegment(raw),
    );
}

export function amPathToMst(path: AmPath): string {
  if (path.length === 0) return "";
  return "/" + path.map((seg) => escapeSegment(String(seg))).join("/");
}

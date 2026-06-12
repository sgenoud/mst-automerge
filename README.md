# mst-automerge

Two-way binding between [mobx-state-tree](https://mobx-state-tree.js.org) (MST) and
[Automerge](https://automerge.org). Mutate your MST tree through actions as usual; the
changes land in an Automerge document (and sync wherever `automerge-repo` takes them).
Remote changes are applied back onto the live tree, preserving node identity. Conflict
resolution is entirely Automerge's CRDT semantics — this library is a faithful, loop-free
translator.

Inspired by [mobx-keystone's Yjs binding](https://mobx-keystone.js.org/integrations/yjs-binding/).

## Quickstart

```ts
import { Repo } from "@automerge/automerge-repo";
import { types, type SnapshotIn } from "mobx-state-tree";
import {
  AutomergeCounter,
  AutomergeText,
  bindMSTToAutomerge,
} from "mst-automerge";

const Todo = types.model("Todo", {
  title: types.optional(AutomergeText, ""),
  votes: types.optional(AutomergeCounter, 0),
  done: false,
});
const Store = types
  .model("Store", { todos: types.array(Todo) })
  .actions((self) => ({
    addTodo(title: string) {
      self.todos.push({ title });
    },
  }));

const repo = new Repo({
  network: [
    /* your adapters */
  ],
});
const handle = repo.create<SnapshotIn<typeof Store>>();

const { node, dispose } = await bindMSTToAutomerge({
  type: Store,
  handle,
  initialSnapshot: { todos: [] },
});

node.addTodo("hello"); // -> lands in the doc, syncs to peers
node.todos[0]!.title.insert(5, "!"); // -> a CRDT text splice
node.todos[0]!.votes.increment(); // -> a CRDT counter increment
// remote changes arriving on `handle` update `node` in place, reactively
```

## What merges how

| Tree shape                                           | Doc representation | Concurrent edits                             |
| ---------------------------------------------------- | ------------------ | -------------------------------------------- |
| plain field (`types.string`, `number`, `boolean`, …) | scalar             | last-writer-wins                             |
| `types.model` / `types.map`                          | map                | per-key (disjoint keys both survive)         |
| `types.array`                                        | list CRDT          | positional — concurrent inserts both survive |
| `AutomergeText`                                      | text CRDT          | splices interleave by position               |
| `AutomergeCounter`                                   | counter            | increments add up                            |
| `types.frozen`                                       | opaque subtree     | last-writer-wins, replaced wholesale         |

Note that plain `types.string` fields are also text CRDTs in the document (every
Automerge string is); use `AutomergeText` when you want splice-level _local_ edit
intent (`insert`/`delete`) instead of whole-value assignment.

## API

### `bindMSTToAutomerge({ type, handle, initialSnapshot?, onSyncError? })`

Returns `Promise<{ node, handle, dispose }>`.

Bootstrap rules:

- **empty doc + `initialSnapshot`** — the doc is seeded from the snapshot;
- **non-empty doc** — the doc wins, `initialSnapshot` is ignored (it is a seed, not a
  merge input; the doc is the replicated source of truth);
- type defaults missing from the doc are written back once (only missing keys — never
  rewrites existing values, so rebinding is idempotent);
- counter fields are converted to `Automerge.Counter` once (existing counters keep
  their history).

`dispose()` detaches both directions; node and doc stay usable, just unsynced.

`onSyncError(error)` is called when an inbound change cannot be applied (e.g. another
peer wrote something that violates the MST type). The tree keeps its last valid state
and resyncs fully on the next applicable change. Default: `console.error` (DocHandle
emits change events through a decoupled state machine, so throwing cannot reach the
code that caused the change).

### `AutomergeCounter`

MST model node with `value`, `increment(by = 1)`, `decrement(by = 1)`. Snapshots as a
**raw number**. Any change to `value` — including via `applySnapshot` — is translated
into an increment by the delta, so it merges additively. Replacing the wrapper node
itself resets the counter.

### `AutomergeText`

MST model node with `value`, `length`, `insert(index, text)`, `delete(index, count)`,
`set(text)`. Snapshots as a **raw string**. All value changes go through
`Automerge.updateText`, which diffs into minimal splices. Indices are UTF-16 code
units, identical to JS string indexing.

### `createDocFromTree(repo, node)`

Creates a fresh doc mirroring an existing (possibly unbound) tree, counters included.
Binding the returned handle later produces no further bootstrap changes.

### Lower-level pieces

`bindOutbound` / `bindInbound` (one direction each), `snapshotToDoc` / `docToSnapshot`
(plain-JSON ⇄ doc conversion), `mstPathToAm` / `amPathToMst` (path formats).

## How it works

- **Outbound** (tree → doc): `onPatch` output is classified per patch — counter value
  changes become `inc` deltas, text value changes become `updateText` calls,
  everything else is replayed structurally (array `add` becomes a real CRDT
  `insertAt`, so inserts merge as inserts). All patches of one top-level action flush
  as a single Automerge change.
- **Inbound** (doc → tree): events with no container grafts apply patch-by-patch,
  O(change) — typing, toggles, increments. Events that graft objects replay into a
  plain-JS shadow snapshot first (sync-received patch streams interleave objects
  arbitrarily, so intermediates can violate MST types), then apply once via
  `applySnapshot`; MST reconciliation preserves node identity.
- **Echo suppression**: a per-binding flag pair; each direction's listener ignores
  events raised while the opposite direction is applying.

## Limitations (v1)

- No rich text marks; no undo manager (the origin-flag design leaves room for one).
- MST volatile state and views are not synced (by design); `types.Date` and friends
  work via their JSON snapshots.
- Schema evolution is the application's job: a doc with unknown/missing fields that
  the type cannot accept fails loudly at bind time (wrap your type's snapshot handling
  with `types.snapshotProcessor` to migrate).
- Inbound structural events cost O(tree); fine for typical UI state, measured by the
  perf smoke test (2k nodes, 600 ops < 1s total).

## Development

```sh
npm test            # full suite: unit, characterization, convergence, property tests
npm run typecheck
npm run build       # ESM + .d.ts via tsup
```

The test suite contains **characterization tests** that pin the exact patch shapes of
mobx-state-tree and Automerge this binding relies on. If a dependency upgrade changes
those shapes, the characterization suites fail first and point at what to review. The
convergence suite runs two real repos over a MessageChannel network adapter, including
a fast-check property test applying random concurrent op interleavings on both sides.

See `PROPOSAL.md` for the design history, including the M6 pivot from per-patch
inbound application to shadow replay.

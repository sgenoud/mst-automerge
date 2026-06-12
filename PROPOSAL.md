# Proposal: `mst-automerge` — an Automerge synchronization layer for mobx-state-tree

## 1. Goal

Provide a two-way binding between a [mobx-state-tree](https://mobx-state-tree.js.org) (MST)
tree and an [Automerge](https://automerge.org) document, so that:

- Local mutations of the MST tree (through actions) are reflected into an Automerge
  document (and thus picked up by `automerge-repo` storage/network adapters).
- Remote/concurrent changes arriving on the Automerge document are applied back onto the
  live MST tree, preserving node identity wherever possible.
- Conflict resolution is delegated entirely to Automerge's CRDT semantics; the binding's
  job is faithful, loop-free translation in both directions.
- Special collaborative primitives — **counters** and **text** — are exposed as MST types
  whose _intent_ (increment, splice) is carried into Automerge, instead of being flattened
  into last-writer-wins value replacements.

This mirrors the shape of mobx-keystone's Yjs binding (`bindYjsToMobxKeystone`): a single
entry point returning a bound instance plus a `dispose()`, an origin marker to suppress
echo loops, helpers to bootstrap a document from a snapshot, and wrapper models for the
non-JSON primitives.

### Non-goals (v1)

- No custom network or storage adapters — we sit on top of `automerge-repo` and stay
  transport-agnostic.
- No rich text / marks support (Automerge marks can come later as an extension of the
  text primitive).
- No undo/redo manager (Automerge has no built-in undo; designing one is out of scope,
  but the binding must not preclude it — see §8).
- No support for MST types without a JSON-stable snapshot (e.g. `types.Date` is fine via
  snapshot processors, but volatile state and views are simply not synced, by design).

## 2. Background: the two APIs we glue together

### mobx-state-tree

- `onPatch(node, (patch, reversePatch) => void)` — emits RFC-6902-style JSON patches for
  every mutation: `{ op: "add" | "replace" | "remove", path: "/todos/0/title", value? }`.
  Patches are emitted per-mutation but grouped inside a MobX transaction per action.
- `applyPatch(node, patchOrPatches)` — applies one or more JSON patches to a live tree
  (this is itself an action).
- `getSnapshot` / `applySnapshot` / `onSnapshot` — whole-tree serialization. Snapshots are
  plain JSON, which makes them the natural bootstrap format.
- `onAction` / `addMiddleware` — lets us observe _named actions with arguments_ before
  they decompose into patches. This is the key to intent-preserving primitives: a
  `counter.increment(5)` action is visible as an action call even though its patch is just
  `replace /count`.
- `recordPatches(node)` — groups patches produced during a code block; useful for testing
  and for batching.

### Automerge / automerge-repo

- Packages: `@automerge/automerge` (document & CRDT), `@automerge/automerge-repo`
  (Repo, DocHandle, storage/network adapters), plus adapter packages.
- `repo.create<T>()` / `repo.find<T>(url)` → `DocHandle<T>`.
- `handle.change(doc => { mutate doc })` — all writes happen inside a change callback on a
  mutable proxy.
- `handle.on("change", ({ doc, patches, patchInfo }) => ...)` — fires for **both** local and
  remote changes, with Automerge patches:
  `{ action: "put" | "del" | "insert" | "splice" | "inc" | ..., path: ["todos", 0, "title"], value? }`.
  `patchInfo.source` distinguishes `"change"` (local) from `"applyChanges"`/sync (remote) —
  we will verify and pin this down in tests rather than trust it blindly, and keep our own
  origin flag as the primary echo guard.
- `new Automerge.Counter(n)` — a CRDT counter; `doc.count.increment(d)` inside a change;
  concurrent increments merge additively. Surfaces in reads as a `Counter` object with
  `.value`.
- Text: plain JS strings stored as CRDT text sequences; edited with
  `Automerge.splice(doc, ["path"], index, delCount, insertText)` or
  `Automerge.updateText(doc, ["path"], newValue)` (which diffs internally). Concurrent
  edits at different positions both survive a merge.

### The impedance mismatches the binding must own

1. **Path formats**: MST `"/todos/0/title"` (string, JSON-pointer, escaped `~0`/`~1`)
   vs Automerge `["todos", 0, "title"]` (array, numeric indices).
2. **Write models**: MST mutates a live observable tree; Automerge mutates a proxy inside
   `change()`. Both sides re-emit what we apply — echo suppression is mandatory in both
   directions.
3. **Arrays**: MST emits `add`/`remove`/`replace` at indices; Automerge emits
   `insert`/`del`. Concurrent array edits merge fine _inside Automerge_; our MST→Automerge
   translation must use real `insertAt`/`deleteAt`/`splice` on the proxy (not index
   assignment) so the CRDT sees inserts as inserts.
4. **Intent loss**: a string `replace` patch can't tell us the user typed one character;
   a number `replace` can't tell us it was an increment. Hence the wrapper primitives (§5).
5. **Identity**: applying a whole snapshot to MST recreates nodes (losing references,
   component state keyed on identity). The remote→MST direction must therefore apply
   _patches_, falling back to `applySnapshot` only for initial load / resync.

## 3. Proposed public API

```ts
import { Repo, DocHandle } from "@automerge/automerge-repo"
import { IAnyModelType, Instance, SnapshotIn } from "mobx-state-tree"

/** Bind an MST model type to an automerge DocHandle (two-way). */
export function bindMSTToAutomerge<T extends IAnyModelType>(opts: {
  type: T
  handle: DocHandle<SnapshotIn<T>>
  /** Provided when the doc is empty/new; ignored if the doc already has content. */
  initialSnapshot?: SnapshotIn<T>
}): Promise<{
  node: Instance<T>          // the live, bound MST instance
  handle: DocHandle<SnapshotIn<T>>
  dispose(): void            // detach listeners; node and doc remain usable
}>

/** One-shot helpers (also used internally for bootstrap). */
export function snapshotToDoc(snapshot, doc /* mutable change proxy */): void
export function docToSnapshot(doc): unknown   // unwraps Counter -> {value}, etc.

/** Convenience: create a fresh doc in a repo from an existing (possibly unbound) tree. */
export function createDocFromTree(repo: Repo, node: IAnyStateTreeNode): DocHandle<...>

/** Collaborative primitives (MST types) */
export const AutomergeCounter: /* MST model { value: number } + increment(by) */
export const AutomergeText:    /* MST model { value: string } + splice/insert/delete/set */
```

Usage sketch:

```ts
const Todo = types.model("Todo", {
  title: AutomergeText,
  votes: AutomergeCounter,
  done: types.boolean,
});
const Store = types.model("Store", { todos: types.array(Todo) });

const repo = new Repo({ network: [new BroadcastChannelNetworkAdapter()] });
const handle = repo.create<SnapshotIn<typeof Store>>();

const { node, dispose } = await bindMSTToAutomerge({
  type: Store,
  handle,
  initialSnapshot: { todos: [] },
});

// Local edits sync out:
node.todos[0].title.insert(0, "Hello"); // -> Automerge.splice
node.todos[0].votes.increment(); // -> Counter.increment
// Remote patches arriving on `handle` are applied onto `node` in place.
```

## 4. Architecture

```
            MST tree                                Automerge DocHandle
  ┌─────────────────────────┐                 ┌──────────────────────────┐
  │ actions mutate the tree │                 │  handle.change(d => ...) │
  └────────────┬────────────┘                 └────────────▲─────────────┘
               │ onPatch / onAction (intent)               │
               ▼                                           │
     [outbound translator] ── MST patch → AM mutation ─────┘
               ▲                                           │
               │                              handle.on("change", {patches})
     [inbound translator]  ◀── AM patch → MST JSON patch ──┘
               │
               ▼
        applyPatch(node, ...)        (guarded by `applyingRemote` flag)
```

Key mechanisms:

- **Echo suppression (origin flag).** A module-level (per-binding) `origin` state:
  outbound translation runs inside `handle.change()` while `origin = "local"`; the
  `handle.on("change")` listener ignores events while `origin === "local"`. Inbound
  application runs `applyPatch` while `origin = "remote"`; the `onPatch` listener ignores
  patches while `origin === "remote"`. This is the same trick as mobx-keystone's
  `yjsOrigin` transaction marker, adapted to flags because Automerge changes don't carry
  arbitrary origins.
- **Batching.** MST emits one patch per primitive mutation. We buffer patches and flush
  them in a single `handle.change()` per MobX transaction (via `onAction`'s
  after-hook or a microtask flush), so one user action = one Automerge change = one sync
  message.
- **Intent interception.** `addMiddleware` watches for actions on `AutomergeCounter` /
  `AutomergeText` instances. When such an action fires, the binding records an _intent op_
  (`{kind: "inc", path, by}` / `{kind: "splice", path, index, del, insert}`) and marks the
  resulting plain patches on that subtree as _consumed_, so the outbound translator emits
  the CRDT operation instead of a value `put`.
- **Inbound mapping.** Automerge patches → MST patches:
  - `put` → `add`/`replace` (value converted: `Counter` → `{value}` snapshot)
  - `del` (map key) → `remove`; `del` (list index, length n) → n `remove` ops
  - `insert` → `add` at index
  - `splice` (text) → routed to the owning `AutomergeText` node as an internal action,
    not as a whole-string replace
  - `inc` → internal action on the owning `AutomergeCounter` node
- **Bootstrap** (mirrors `convertJsonToYjsData`): if the doc is empty →
  `handle.change(d => snapshotToDoc(initialSnapshot, d))`; if the doc has content →
  `Store.create(docToSnapshot(handle.doc()))`. If both exist and differ, the doc wins
  (it is the replicated source of truth); the snapshot is only a seed.

### Module layout

```
src/
  index.ts            public API
  bind.ts             bindMSTToAutomerge, lifecycle, origin flags
  paths.ts            JSON-pointer <-> path-array conversion (incl. ~0/~1 escaping)
  outbound.ts         MST patches + intent ops  -> mutations on the change proxy
  inbound.ts          Automerge patches         -> MST JSON patches / internal actions
  convert.ts          snapshotToDoc / docToSnapshot (Counter & text aware)
  primitives/
    counter.ts        AutomergeCounter MST type
    text.ts           AutomergeText MST type
test/
  ...mirrors src, plus convergence/ integration tests
```

Tooling: TypeScript, Vitest, `@automerge/automerge` + `@automerge/automerge-repo` (with
`automerge-repo-network-messagechannel` or the in-memory pair for tests), `mobx`,
`mobx-state-tree`. No bundler decision needed until the API stabilizes (tsup at the end).

## 5. Collaborative primitives

Plain MST mapping would make these last-writer-wins; the wrappers preserve merge
semantics:

### `AutomergeCounter`

```ts
const AutomergeCounter = types
  .model("AutomergeCounter", { value: 0 })
  .actions((self) => ({
    increment(by = 1) {
      self.value += by;
    },
    decrement(by = 1) {
      self.value -= by;
    },
  }));
```

- In the Automerge doc, the field is stored as `new Automerge.Counter(value)`.
- Outbound: the middleware sees `increment(by)` and emits `proxy.path.increment(by)`
  inside the change; the underlying `replace /value` patch is swallowed.
- Inbound: an `inc` patch calls a hidden `_applyRemoteDelta(by)` action.
- Direct assignment (e.g. via `applySnapshot`) is either rejected or translated to a
  delta — decided by test M7.3 below (proposal: translate to delta, it keeps
  `applySnapshot` working).

### `AutomergeText`

```ts
const AutomergeText = types
  .model("AutomergeText", { value: "" })
  .actions(self => ({
    insert(index: number, text: string) { ... },
    delete(index: number, count: number) { ... },
    set(text: string) { ... },   // convenience: diffed via updateText
  }))
  .views(self => ({ get length() { return self.value.length } }))
```

- Stored as a plain string field in the doc (Automerge text CRDT).
- Outbound: `insert`/`delete` → `Automerge.splice`; `set` → `Automerge.updateText`
  (Automerge computes a minimal diff, so even naive `set` calls merge reasonably).
- Inbound: `splice`/`del` patches inside the text are applied as index-precise edits to
  `self.value` via a hidden action, so local cursor logic built on top can observe
  granular changes.
- Like mobx-keystone's `YjsTextModel`, this is a _model node_, not a string — the
  ergonomic cost (`todo.title.value`) buys CRDT-correct merging. A
  `types.snapshotProcessor` keeps snapshots tolerable (`{ value: "..." }`, or even raw
  string in/out — test-driven decision in M8.1).

## 6. Red–green build plan

Each milestone below starts by writing the listed tests (red), then the minimal
implementation to pass them (green), then refactoring with the suite as a net. Milestones
are ordered so every one builds on a passing previous one, and the riskiest unknowns
(patch shapes on both sides) are pinned down by tests _before_ the binding logic exists.

### M0 — Scaffolding (no red/green, ~30 min)

`package.json`, TypeScript, Vitest, dependencies, CI script (`npm test`). One smoke test:
create an MST model and an Automerge doc in the same file.

### M1 — Path translation (`paths.ts`) — pure functions first

Red tests:

- `mstPathToAm("/todos/0/title")` → `["todos", 0, "title"]`
- `amPathToMst(["todos", 0, "title"])` → `"/todos/0/title"`
- escaping: `"/a~1b/c~0d"` ↔ `["a/b", "c~d"]`
- numeric-looking map keys survive round-trip given a type-aware hint (document the
  chosen strategy: indices are numbers only when the parent is a list).

### M2 — Snapshot ⇄ document conversion (`convert.ts`)

Red tests:

- `snapshotToDoc` writes nested objects/arrays/primitives; reading the doc back with
  `docToSnapshot` round-trips deep-equal for a representative fixture (objects in arrays
  in maps, null/optional fields, unicode strings).
- `docToSnapshot` unwraps `Counter` instances to plain numbers shaped for the wrapper
  model's snapshot.
- Characterization tests that _pin Automerge behavior we rely on_: what patches a `put`
  of a nested object emits, how list pushes surface (`insert` + `put`s), what a text
  `splice` patch looks like. These tests exist to fail loudly on Automerge upgrades.

### M3 — Outbound one-way sync (MST → Automerge)

Bind only `onPatch` → `handle.change` (no inbound listener yet).

Red tests (each is one `it()` asserting on `handle.doc()` after an MST action):

- replace a primitive at the root and nested
- add / remove a map entry (`types.map`)
- array: push, unshift, splice-in-middle, remove, in-place replace — asserting the doc
  content **and** (characterization) that inserts produce `insert` patches, because
  index-assignment in the change proxy would silently become `put` and break merging
- one MST action performing 5 mutations → exactly one new Automerge change (batching)
- patches produced _by_ `applyPatch`/`applySnapshot` on the MST side also sync out

### M4 — Inbound one-way sync (Automerge → MST)

Bind only `handle.on("change")` → `applyPatch` (construct the tree from the doc first).

Red tests (mutate the doc directly via `handle.change`, assert on the MST node):

- put/replace primitive, nested object graft (put of an object → MST `add` with value)
- map key delete
- list insert / delete / multi-element splice
- node identity: replacing `todos[0].title` must keep the same `todos[0]` MST node
  instance (`getPath` stable, reference equality of the node before/after)
- a remote change touching 10 fields applies in one MobX transaction (one `onSnapshot`
  tick on the MST side)

### M5 — Two-way binding, echo suppression, bootstrap (`bind.ts`)

Red tests:

- bind, mutate MST → doc updated, **and no feedback re-application** (count `onPatch`
  emissions; assert no second application, no infinite loop — use a patch counter and a
  recursion guard with a hard fail)
- bind, mutate doc → MST updated, no echo back into a new Automerge change (assert
  `getHistory(doc).length` doesn't grow from the echo)
- bootstrap: empty doc + `initialSnapshot` → doc seeded; non-empty doc + snapshot → doc
  wins; non-empty doc, no snapshot → tree built from doc
- `dispose()` detaches both directions (mutations after dispose don't propagate)
- rebinding after dispose works

### M6 — Convergence (the actual point of the library)

Two `Repo`s connected by a MessageChannel/in-memory adapter pair, each with its own bound
MST tree over the same document URL.

Red tests:

- edit A → appears in B's tree (await sync settle helper)
- concurrent disjoint edits (A edits `todos[0].done`, B edits `todos[1].title`) → both
  trees converge deep-equal to each other and to `docToSnapshot`
- concurrent list inserts at the same index → both trees converge (order decided by
  Automerge; we only assert convergence + both elements present)
- offline/merge: disconnect, both sides edit, reconnect → converge
- property-based test (fast-check, small op vocabulary: set field, push, delete, splice)
  applying random op interleavings on both sides → trees converge. This is the regression
  net for everything that follows.

### M7 — `AutomergeCounter`

Red tests:

- 7.1 unit: model increments locally without a binding (plain MST behavior)
- 7.2 bound: `increment(3)` → doc field is a `Counter` with value 3; underlying
  `replace` patch was swallowed (doc history contains an `inc` op, not a `put`)
- 7.3 `applySnapshot` with a counter value → behavior per decision in §5 (delta), test
  encodes it
- 7.4 convergence: A increments by 2, B increments by 3 concurrently → both converge to 5
  (the test that a plain number cannot pass)
- 7.5 inbound `inc` patch updates `node.value` reactively (a MobX `autorun` observes it)

### M8 — `AutomergeText`

Red tests:

- 8.1 snapshot ergonomics: decide & encode snapshot format (raw string via
  `snapshotProcessor` preferred)
- 8.2 bound: `insert`/`delete` produce splice ops (doc history characterization), `set`
  goes through `updateText`
- 8.3 inbound splice patches update `value` and are observable granularly
- 8.4 convergence: A inserts at position 0, B appends at the end, concurrently → merged
  string contains both edits in order ("Hello world" → "Oh, Hello world!" style fixture)
- 8.5 unicode: emoji/surrogate pairs across splice boundaries round-trip (Automerge
  indexes are not UTF-16 naive — pin the actual unit in a characterization test first)

### M9 — Hardening & ergonomics

Red tests as needed:

- `createDocFromTree(repo, node)` helper
- error paths: binding a doc whose content doesn't pass the MST type check → clear error
  (and a documented `onTypeError` escape hatch rather than a crash mid-sync)
- large-tree smoke benchmark (not a unit test): 10k nodes bootstrap + 1k random ops,
  asserting time stays within a generous bound to catch O(n²) regressions
- `types.frozen` subtrees: synced as opaque values (documented LWW semantics)

### M10 — Docs & packaging

README with the usage sketch, semantics table ("what merges how": plain field = LWW,
array = positional CRDT, counter = additive, text = splice CRDT), tsup build, exports map.

Estimated rhythm: M1–M5 are the core and worth doing strictly test-first; M6's
property test is the contract that keeps M7–M9 honest.

## 7. Key design decisions (and why)

| Decision                                          | Choice                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patches vs snapshots for sync                     | **Patches out; shadow-replay + reconciling applySnapshot in** (revised in M6) | Outbound MST patches preserve intent (inserts stay inserts). Inbound, sync-received streams are diff-derived and interleave objects arbitrarily — a new object's fill patches can arrive after unrelated patches, so per-patch application hits type-invalid intermediates (`{}` is not a `Todo`). The batch instead replays into a plain-JS shadow snapshot (type-free, order-tolerant), applied once via `applySnapshot`; MST reconciliation preserves node identity. O(tree) per inbound event is the accepted v1 cost. |
| Where conflict resolution lives                   | Automerge only                                                                | The binding never merges; it replays. Keeps it auditable and testable by convergence tests.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Echo suppression                                  | Per-binding origin flags on both listeners                                    | Automerge changes can't carry arbitrary origin metadata like Yjs transactions; flags + synchronous application windows are sufficient and testable (M5).                                                                                                                                                                                                                                                                                                                                                                   |
| Counter/Text as model nodes (not primitive types) | Model nodes with actions                                                      | MST custom primitive types can't carry actions, and intent capture needs actions. Same trade-off mobx-keystone made with `YjsTextModel`.                                                                                                                                                                                                                                                                                                                                                                                   |
| Doc wins over `initialSnapshot`                   | Yes                                                                           | The document is the replicated truth; a seed snapshot racing against an already-synced doc must not fork state.                                                                                                                                                                                                                                                                                                                                                                                                            |

## 8. Risks & open questions

1. **MST array patch shapes.** Exactly which patch sequences MST emits for `splice` in
   the middle of an array is under-documented; M3's characterization tests resolve this
   before the translator is written. If MST emits shifted `replace`s instead of
   `add`/`remove` at the index, the outbound translator may need the _reverse patch_ (also
   provided by `onPatch`) or an action-level interception of array methods to recover
   insert intent. This is the highest-risk item and is deliberately scheduled early.
2. **`patchInfo.source` reliability** for distinguishing local vs remote changes across
   automerge-repo versions — mitigated by owning our origin flags (M5).
3. **Async handle readiness.** `repo.find()` is async and a handle may be unavailable;
   `bindMSTToAutomerge` is async and awaits `whenReady`. Tests must cover binding to a
   not-yet-synced handle.
4. **applyPatch reentrancy.** `applyPatch` is itself an action; inbound application must
   not be re-captured by the intent middleware (flag check in the middleware, tested in
   M7.5/M8.3).
5. **Undo.** A future bound-undo (like mobx-keystone's `undoMiddleware` integration)
   would need inverse patches scoped to local origin only; the origin flag design keeps
   that door open.
6. **Schema evolution.** MST types are strict; old docs with extra/missing fields need
   `snapshotProcessor`-based migration on `docToSnapshot`. Documented, not solved, in v1.

## 9. Deliverable of the next step

If this proposal looks right, the next session starts M0+M1: scaffold the package and
write the failing path-translation and characterization tests — the latter are pure
discovery and will likely adjust details in §4's inbound/outbound tables before any
binding code exists.

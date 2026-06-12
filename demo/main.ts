// The vite config aliases @automerge/automerge(-repo) to their /slim
// entries, so the WASM must be initialized explicitly before first use.
import { initializeWasm } from "@automerge/automerge/slim";
// eslint-disable-next-line import/no-unresolved -- vite ?url asset import
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import {
  isValidAutomergeUrl,
  Repo,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { autorun } from "mobx";
import { types, type Instance, type SnapshotIn } from "mobx-state-tree";
import {
  AutomergeCounter,
  AutomergeText,
  bindMSTToAutomerge,
} from "../src/index";

await initializeWasm(wasmUrl);

// ---------------------------------------------------------------- the model

const Todo = types
  .model("Todo", {
    id: types.identifier,
    title: types.string,
    done: false,
  })
  .actions((self) => ({
    toggle() {
      self.done = !self.done;
    },
  }));

const Store = types
  .model("Store", {
    count: types.optional(AutomergeCounter, 0),
    note: types.optional(AutomergeText, ""),
    todos: types.array(Todo),
  })
  .actions((self) => ({
    addTodo(title: string) {
      self.todos.push({ id: crypto.randomUUID(), title });
    },
    removeTodo(id: string) {
      const todo = self.todos.find((t) => t.id === id);
      if (todo) self.todos.remove(todo);
    },
  }));

type StoreInstance = Instance<typeof Store>;

// ------------------------------------------------- repo, doc, binding setup

// All tabs of this origin share one IndexedDB; live sync runs over a
// BroadcastChannel. The doc URL travels via location.hash + localStorage so
// every tab lands on the same document.
const repo = new Repo({
  storage: new IndexedDBStorageAdapter("mst-automerge-demo"),
  network: [new BroadcastChannelNetworkAdapter()],
});

async function locateHandle() {
  const fromHash = location.hash.slice(1);
  const fromStorage = localStorage.getItem("mst-automerge-demo-url");
  const candidate = isValidAutomergeUrl(fromHash)
    ? fromHash
    : isValidAutomergeUrl(fromStorage)
      ? (fromStorage as AutomergeUrl)
      : null;

  if (candidate) {
    try {
      // fail fast if the pointer is stale (cleared IndexedDB, no peer online)
      return await repo.find<SnapshotIn<typeof Store>>(candidate, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // fall through and start a fresh document
    }
  }
  return repo.create<SnapshotIn<typeof Store>>();
}

const handle = await locateHandle();
location.hash = handle.url;
localStorage.setItem("mst-automerge-demo-url", handle.url);

const { node } = await bindMSTToAutomerge({
  type: Store,
  handle,
  initialSnapshot: {},
  onSyncError: (e) => console.error("sync error", e),
});

// --------------------------------------------------- disconnect / reconnect

let adapter: BroadcastChannelNetworkAdapter | null = repo.networkSubsystem
  .adapters[0] as BroadcastChannelNetworkAdapter;

const statusBar = document.getElementById("status-bar")!;
const statusLabel = document.getElementById("status-label")!;
const toggleButton = document.getElementById(
  "toggle-connection",
) as HTMLButtonElement;

toggleButton.addEventListener("click", () => {
  if (adapter) {
    repo.networkSubsystem.removeNetworkAdapter(adapter);
    adapter = null;
    statusBar.classList.add("offline");
    statusLabel.textContent = "offline";
    toggleButton.textContent = "reconnect";
  } else {
    // a fresh adapter re-handshakes with the other tabs and the sync
    // protocol exchanges everything missed while offline
    adapter = new BroadcastChannelNetworkAdapter();
    repo.networkSubsystem.addNetworkAdapter(adapter);
    statusBar.classList.remove("offline");
    statusLabel.textContent = "online";
    toggleButton.textContent = "disconnect";
  }
});

document.getElementById("doc-url")!.textContent = handle.url.slice(0, 24) + "…";

// ----------------------------------------------------------------- counter

document
  .getElementById("inc")!
  .addEventListener("click", () => node.count.increment());
document
  .getElementById("dec")!
  .addEventListener("click", () => node.count.decrement());

autorun(() => {
  document.getElementById("count")!.textContent = String(node.count.value);
});

// -------------------------------------------------------------------- note

const noteArea = document.getElementById("note") as HTMLTextAreaElement;

noteArea.addEventListener("input", () => {
  node.note.set(noteArea.value);
});

autorun(() => {
  const value = node.note.value;
  if (noteArea.value === value) return;
  // naive cursor preservation: keep the same offset across remote updates
  const { selectionStart, selectionEnd } = noteArea;
  noteArea.value = value;
  if (document.activeElement === noteArea) {
    noteArea.setSelectionRange(
      Math.min(selectionStart, value.length),
      Math.min(selectionEnd, value.length),
    );
  }
});

// ------------------------------------------------------------------- todos

const todoList = document.getElementById("todos") as HTMLUListElement;
const todoForm = document.getElementById("add-todo") as HTMLFormElement;
const todoInput = document.getElementById("new-todo") as HTMLInputElement;

todoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = todoInput.value.trim();
  if (title) {
    node.addTodo(title);
    todoInput.value = "";
  }
});

function renderTodo(todo: Instance<typeof Todo>): HTMLLIElement {
  const li = document.createElement("li");
  li.className = todo.done ? "done" : "";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = todo.done;
  checkbox.addEventListener("change", () => todo.toggle());

  const span = document.createElement("span");
  span.textContent = todo.title;

  const remove = document.createElement("button");
  remove.textContent = "✕";
  remove.title = "delete";
  remove.addEventListener("click", () => node.removeTodo(todo.id));

  li.append(checkbox, span, remove);
  return li;
}

autorun(() => {
  // track list structure and each todo's fields, then rebuild
  const todos = node.todos.map((t) => ({
    ref: t,
    done: t.done,
    title: t.title,
  }));
  todoList.replaceChildren(...todos.map(({ ref }) => renderTodo(ref)));
});

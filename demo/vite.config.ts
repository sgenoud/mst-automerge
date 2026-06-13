import { defineConfig } from "vite";

export default defineConfig({
  // Emit relative asset paths ("./assets/…") so the built app works when
  // served from a subpath or opened from disk, not only from the domain
  // root. With the default absolute "/assets/…", the JS bundle 404s under a
  // subpath and the app never runs (so the doc-url hash is never set).
  base: "./",
  // Use the slim entries (no embedded WASM import, which the bundler can't
  // process); main.ts initializes the WASM explicitly from a ?url asset.
  resolve: {
    alias: [
      {
        find: /^@automerge\/automerge$/,
        replacement: "@automerge/automerge/slim",
      },
      {
        find: /^@automerge\/automerge-repo$/,
        replacement: "@automerge/automerge-repo/slim",
      },
    ],
  },
  build: {
    target: "esnext", // top-level await
  },
});

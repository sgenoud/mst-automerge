import { defineConfig } from "vite";

export default defineConfig({
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

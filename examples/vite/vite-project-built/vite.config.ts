import { defineConfig } from "vite";

export default defineConfig({
  // Use relative URLs to reference other files, in order to allow built assets
  // to be served from any path.
  base: "",
  resolve: {
    // Include only specific data sources.
    conditions: [
      "neuroglancer/datasource:none_by_default",
      "neuroglancer/datasource/precomputed:enabled",
    ],
  },
  worker: {
    // Required due to use of dynamic imports in Neuroglancer.
    format: "es",
  },
  build: {
    // Avoid spurious warnings due to large chunks from Neuroglancer.
    chunkSizeWarningLimit: 2 * 1024 * 1024,
  },
  server: {
    fs: {
      // Allow serving files from parent neuroglancer project, due to the local
      // path reference.  This would not be needed for projects that depend on
      // Neuroglancer normally, or when using pnpm rather than npm.
      allow: ["../../.."],
    },
  },
  optimizeDeps: {
    // Neuroglancer is incompatible with Vite's optimizeDeps step used for the
    // dev server due to its use of `new URL` syntax (not supported by esbuild).
    exclude: ["neuroglancer"],
    // Some of Neuroglancer's dependencies are CommonJS modules for which the
    // optimizeDeps step is mandatory.
    //
    // There does not seem to be a way to avoid having to specify all of these
    // explicitly.
    include: [
      "neuroglancer > codemirror",
      "neuroglancer > codemirror/mode/javascript/javascript.js",
      "neuroglancer > codemirror/addon/fold/foldcode.js",
      "neuroglancer > codemirror/addon/fold/foldgutter.js",
      "neuroglancer > codemirror/addon/fold/brace-fold.js",
      "neuroglancer > codemirror/addon/lint/lint.js",
      "neuroglancer > core-js/actual/symbol/dispose.js",
      "neuroglancer > core-js/actual/symbol/async-dispose.js",
    ],
  },
});

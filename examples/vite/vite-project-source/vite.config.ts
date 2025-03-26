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
  esbuild: {
    // Needed to acommodate decorator usage in Neuroglancer TypeScript sources.
    target: "es2022",
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
    entries: [
      "index.html",
      // In order for Vite to properly find all of Neuroglancer's transitive
      // dependencies, instruct Vite to search for dependencies starting from
      // all of the bundle entry points.
      //
      // These have to be specified explicitly because vite does not allow globs
      // within `node_modules`.
      "node_modules/neuroglancer/src/main.bundle.js",
      "node_modules/neuroglancer/src/async_computation.bundle.js",
      "node_modules/neuroglancer/src/chunk_worker.bundle.js",
    ],
    // Neuroglancer is incompatible with Vite's optimizeDeps step used for the
    // dev server due to its use of `new URL` syntax (not supported by esbuild).
    exclude: ["neuroglancer"],
  },
});

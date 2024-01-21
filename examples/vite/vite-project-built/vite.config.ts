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
      // Neuroglancer normally.
      allow: ["../../.."],
    },
  },
});

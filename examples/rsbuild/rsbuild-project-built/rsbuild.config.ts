import { defineConfig } from "@rsbuild/core";

export default defineConfig({
  html: {
    title: "rsbuild neuroglancer test",
    scriptLoading: "module",
    mountId: "neuroglancer-container",
  },
  output: {
    // By default, running the dev-server also clears the dist directory.
    cleanDistPath: process.env.NODE_ENV === "production",
    assetPrefix: "./",
    distPath: {
      js: "",
      jsAsync: "",
      wasm: "",
      css: "",
    },
  },
  tools: {
    rspack: {
      module: {
        rules: [
          // Needed for .svg?raw imports used for embedding icons.
          {
            resourceQuery: /raw/,
            type: "asset/source",
          },
          // Needed for .html assets used for auth redirect pages for the brainmaps
          // and bossDB data sources.  Can be skipped if those data sources are
          // excluded.
          {
            test: /\.html$/,
            type: "asset/resource",
            generator: {
              // Filename must be preserved since exact redirect URLs must be allowlisted.
              filename: "[name][ext]",
            },
          },
        ],
      },
    },
  },
  plugins: [],
});

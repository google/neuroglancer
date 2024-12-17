import { defineConfig } from "@rsbuild/core";

export default defineConfig({
  html: {
    title: "rsbuild neuroglancer test",
    scriptLoading: "module",
    mountId: "neuroglancer-container",
  },
  output: {
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
          // Needed to support Neuroglancer TypeScript sources when using
          // Neuroglancer source package directly.
          {
            test: /\.tsx?$/,
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                parser: {
                  syntax: "typescript",
                  decorators: true,
                },
              },
            },
            type: "javascript/auto",
          },
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

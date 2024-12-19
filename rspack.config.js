import path from "node:path";
import { HtmlRspackPlugin, ProgressPlugin } from "@rspack/core";
import { normalizeConfigurationWithDefine } from "./build_tools/rspack/configuration_with_define.js";
import packageJson from "./package.json";

export default (env, args) => {
  const mode = args.mode === "production" ? "production" : "development";
  const config = {
    mode,
    context: import.meta.dirname,
    entry: {
      main: "./src/main.bundle.js",
    },
    performance: {
      // Avoid unhelpful warnings due to large bundles.
      maxAssetSize: 3 * 1024 * 1024,
      maxEntrypointSize: 3 * 1024 * 1024,
    },
    optimization: {
      splitChunks: {
        chunks: "all",
      },
    },
    devtool: "source-map",
    module: {
      rules: [
        // Needed to support Neuroglancer TypeScript sources.
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
            env: {
              targets: packageJson.browserslist,
            },
          },
          type: "javascript/auto",
        },
        {
          test: /\.wasm$/,
          generator: {
            filename: "[name].[contenthash][ext]",
          },
        },
        // Needed for .svg?raw imports used for embedding icons.
        {
          resourceQuery: /raw/,
          type: "asset/source",
        },
        // Needed for .html assets used for auth redirect pages for the
        // brainmaps and bossDB data sources.
        {
          test: /(bossauth|google_oauth2_redirect)\.html$/,
          type: "asset/resource",
          generator: {
            // Filename must be preserved since exact redirect URLs must be allowlisted.
            filename: "[name][ext]",
          },
        },
      ],
    },
    devServer: {
      client: {
        overlay: {
          // Prevent intrusive notification spam.
          runtimeErrors: false,
        },
      },
      hot: false,
    },
    plugins: [
      new ProgressPlugin(),
      new HtmlRspackPlugin({
        title: "neuroglancer",
      }),
    ],
    output: {
      path: path.resolve(import.meta.dirname, "dist", "client"),
      filename: "[name].[chunkhash].js",
      chunkFilename: "[name].[contenthash].js",
      asyncChunks: true,
      clean: true,
    },
    target: ["web", "browserslist"],
    experiments: {
      css: true,
    },
    // Additional defines, to be added via `DefinePlugin`.  This is not a
    // standard webpack configuration property, but is handled specially by
    // `normalizeConfigurationWithDefine`.
    define: {
      // This is the default client ID used for the hosted neuroglancer.
      // In addition to the hosted neuroglancer origin, it is valid for
      // the origins:
      //
      //   localhost:8000
      //   127.0.0.1:8000
      //   localhost:8080
      //   127.0.0.1:8080
      //
      // To deploy to a different origin, you will need to generate your
      // own client ID from on the Google Developer Console and substitute
      // it in.
      NEUROGLANCER_BRAINMAPS_CLIENT_ID: JSON.stringify(
        "639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com",
      ),

      // NEUROGLANCER_CREDIT_LINK: JSON.stringify({url: '...', text: '...'}),
      // NEUROGLANCER_DEFAULT_STATE_FRAGMENT: JSON.stringify('gs://bucket/state.json'),
      // NEUROGLANCER_SHOW_LAYER_BAR_EXTRA_BUTTONS: true,
      // NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP: true

      // NEUROGLANCER_GOOGLE_TAG_MANAGER: JSON.stringify('GTM-XXXXXX'),
    },
    watchOptions: {
      ignored: /node_modules/,
    },
  };
  return env.NEUROGLANCER_CLI
    ? config
    : normalizeConfigurationWithDefine(config);
};

import HtmlWebpackPlugin from "html-webpack-plugin";

export default {
  mode: "development",
  performance: {
    // Avoid unhelpful warnings due to large bundles.
    maxAssetSize: 3 * 1024 * 1024,
    maxEntrypointSize: 3 * 1024 * 1024,
  },
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
      // Necessary to handle CSS files.
      {
        test: /\.css$/,
        use: [{ loader: "style-loader" }, { loader: "css-loader" }],
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
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: "Neuroglancer webpack test",
    }),
  ],
};

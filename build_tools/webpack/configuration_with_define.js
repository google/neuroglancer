// Converts a webpack configuration that optionally contains an extra `define`
// property into a regular webpack configuration with an added `DefinePlugin`.

import webpack from "webpack";

export function normalizeConfigurationWithDefine(config) {
  let { define, plugins, ...rest } = config;
  if (define !== undefined && Object.keys(define).length > 0) {
    plugins ??= [];
    plugins.push(new webpack.DefinePlugin(define));
  }
  return { plugins, ...rest };
}

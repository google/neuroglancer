// Converts an rspack configuration that optionally contains an extra `define`
// property into a regular rspack configuration with an added `DefinePlugin`.

import { DefinePlugin } from "@rspack/core";

export function normalizeConfigurationWithDefine(config) {
  let { define, plugins, ...rest } = config;
  if (define !== undefined && Object.keys(define).length > 0) {
    plugins ??= [];
    plugins.push(new DefinePlugin(define));
  }
  return { plugins, ...rest };
}

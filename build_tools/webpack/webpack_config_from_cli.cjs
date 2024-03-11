// This module is specified as the webpack config module when `cli.ts` invokes
// `webpack-cli` programmatically.
//
// It simply returns the configuration previously set by `cli.ts`.
//
// This module is in cjs format rather than esm format to avoid a separate copy
// being loaded, for some reason, by tsx.

let config = undefined;

module.exports = (...args) => config(...args);
module.exports.setConfig = (newConfig) => {
  config = newConfig;
};

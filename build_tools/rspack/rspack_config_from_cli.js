// This module is specified as the rspack config module when `cli.ts` invokes
// `@rspack/cli` programmatically.
//
// It simply returns the configuration previously set by `cli.ts`.

let config = undefined;

export function setConfig(newConfig) {
  config = newConfig;
}

export default (...args) => config(...args);

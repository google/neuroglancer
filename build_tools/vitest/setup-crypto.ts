// Polyfill for missing `crypto` in jsdom.

import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
});

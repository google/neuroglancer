import { webcrypto } from "node:crypto";
import type { JSDOM } from "jsdom";

declare let jsdom: JSDOM;

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
});

for (const name of [
  /*"DOMParser", "XPathResult", "navigator"*/
] as const) {
  Object.defineProperty(globalThis, name, {
    value: jsdom.window[name],
  });
}

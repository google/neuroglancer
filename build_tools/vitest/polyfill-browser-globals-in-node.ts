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

// Minimally mock WebGL2RenderingContext
// Required for shader_lib.spec.ts tests
if (typeof globalThis.WebGL2RenderingContext === "undefined") {
  (globalThis as any).WebGL2RenderingContext = {
    UNSIGNED_BYTE: 0x1401,
    BYTE: 0x1400,
    UNSIGNED_SHORT: 0x1403,
    SHORT: 0x1402,
    FLOAT: 0x1406,
    INT: 0x1404,
    UNSIGNED_INT: 0x1405,
  };
}

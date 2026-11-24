import { webcrypto } from "node:crypto";
import net from "node:net";
import type { JSDOM } from "jsdom";

declare let jsdom: JSDOM;

// For `localhost`, Node tries IPv6 (::1) first and by default moves to IPv4
// (127.0.0.1) after 250 ms.
// A test server that listens only on ::1 can take longer to accept on a busy
// CI runner.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

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

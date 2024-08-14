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

import { describe, it, expect } from "vitest"

import { parseUrl } from "#src/util/http_request.ts"

describe("parseUrl", () => {
  it("parses http correctly", () => {
    expect(parseUrl("http://example.foo/bar")).toEqual({
      protcol: "http",
      host: "example.foo",
      path: "/bar"
    })
  })
  it("parses http with port correctly", () => {
    expect(parseUrl("http://example.foo:8080/bar")).toEqual({
      protcol: "http",
      host: "example.foo:8080",
      path: "/bar"
    })
  })
  it("parses https correctly", () => {
    expect(parseUrl("https://example.foo/bar")).toEqual({
      protcol: "https",
      host: "example.foo",
      path: "/bar"
    })
  })
  it("parses blob correctly", () => {
    expect(parseUrl("blob:http://example.foo/bar")).toEqual({
      protcol: "http",
      host: "example.foo",
      path: "/bar"
    })
  })
  it("parses blob with port correctly", () => {
    expect(parseUrl("blob:http://example.foo:8080/bar")).toEqual({
      protcol: "http",
      host: "example.foo:8080",
      path: "/bar"
    })
  })
})

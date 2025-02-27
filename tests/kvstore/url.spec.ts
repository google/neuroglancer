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

import { describe, expect, test } from "vitest";
import {
  finalPipelineUrlComponent,
  kvstoreEnsureDirectoryPipelineUrl,
  parsePipelineUrlComponent,
  parseUrlSuffix,
  pipelineUrlJoin,
  resolveRelativePath,
} from "#src/kvstore/url.js";

describe("kvstoreEnsureDirectoryPipelineUrl", () => {
  test("single pipeline component", () => {
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo")).toEqual(
      "http://foo/",
    );
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo/")).toEqual(
      "http://foo/",
    );
  });

  test("with query parameters", () => {
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo?a=b")).toEqual(
      "http://foo/?a=b",
    );
  });

  test("with fragment parameters", () => {
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo#a=b")).toEqual(
      "http://foo/#a=b",
    );
  });

  test("multiple pipeline component", () => {
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo|zarr")).toEqual(
      "http://foo|zarr:",
    );
    expect(kvstoreEnsureDirectoryPipelineUrl("http://foo|zarr:")).toEqual(
      "http://foo|zarr:",
    );
  });

  test("s3", () => {
    expect(kvstoreEnsureDirectoryPipelineUrl("s3://bucket/path")).toEqual(
      "s3://bucket/path/",
    );
  });
});

describe("pipelineUrlJoin", () => {
  test("simple", () => {
    expect(pipelineUrlJoin("gs://foo", "a", "b")).toEqual("gs://foo/a/b");
  });
  test("query parameter", () => {
    expect(pipelineUrlJoin("gs://foo?a=b", "a", "b")).toEqual(
      "gs://foo/a/b?a=b",
    );
    expect(pipelineUrlJoin("gs://foo?a=b|zarr", "a", "b")).toEqual(
      "gs://foo?a=b|zarr:a/b",
    );
  });
});

describe("finalPipelineUrlComponent", () => {
  test("single component", () => {
    expect(finalPipelineUrlComponent("")).toEqual("");
    expect(finalPipelineUrlComponent("gs://a")).toEqual("gs://a");
  });
  test("multiple components", () => {
    expect(finalPipelineUrlComponent("gs://a|zarr")).toEqual("zarr");
    expect(finalPipelineUrlComponent("gs://a|zip:foo|zarr:")).toEqual("zarr:");
  });
});

describe("parsePipelineUrlComponent", () => {
  test("scheme only", () => {
    expect(parsePipelineUrlComponent("zarr")).toEqual({
      scheme: "zarr",
      suffix: undefined,
      url: "zarr",
    });
  });
  test("empty suffix", () => {
    expect(parsePipelineUrlComponent("zarr:")).toEqual({
      scheme: "zarr",
      suffix: "",
      url: "zarr:",
    });
  });
});

describe("parseUrlSuffix", () => {
  test("no suffix", () => {
    expect(parseUrlSuffix(undefined)).toMatchInlineSnapshot(`
      {
        "authorityAndPath": undefined,
        "fragment": undefined,
        "query": undefined,
      }
    `);
  });
  test("empty suffix", () => {
    expect(parseUrlSuffix("")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "",
        "fragment": undefined,
        "query": undefined,
      }
    `);
  });
  test("path only", () => {
    expect(parseUrlSuffix("a/b/")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "a/b/",
        "fragment": undefined,
        "query": undefined,
      }
    `);
  });
  test("query only", () => {
    expect(parseUrlSuffix("?query")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "",
        "fragment": undefined,
        "query": "query",
      }
    `);
  });
  test("fragment only", () => {
    expect(parseUrlSuffix("#fragment")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "",
        "fragment": "fragment",
        "query": undefined,
      }
    `);
  });
  test("path and query", () => {
    expect(parseUrlSuffix("//host/path?query")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "//host/path",
        "fragment": undefined,
        "query": "query",
      }
    `);
  });
  test("path and fragment", () => {
    expect(parseUrlSuffix("//host/path#fragment")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "//host/path",
        "fragment": "fragment",
        "query": undefined,
      }
    `);
  });
  test("path and query and fragment", () => {
    expect(parseUrlSuffix("//host/path?query#fragment")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "//host/path",
        "fragment": "fragment",
        "query": "query",
      }
    `);
  });
  test("path and fragment with fake query", () => {
    expect(parseUrlSuffix("//host/path#fragment?query")).toMatchInlineSnapshot(`
      {
        "authorityAndPath": "//host/path",
        "fragment": "fragment?query",
        "query": undefined,
      }
    `);
  });
});

describe("resolveRelativePath", () => {
  test("empty base", () => {
    expect(resolveRelativePath("", "a")).toEqual("a");
    expect(resolveRelativePath("", "a/")).toEqual("a/");
    expect(resolveRelativePath("", "")).toEqual("");
    expect(() => resolveRelativePath("", "..")).toThrowError(
      /Invalid relative path/,
    );
  });

  test("non empty base", () => {
    expect(resolveRelativePath("base/b", "../c")).toEqual("base/c");
    expect(resolveRelativePath("base/b", "../c/")).toEqual("base/c/");
  });
});

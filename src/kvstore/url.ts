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

export function kvstoreEnsureDirectoryPipelineUrl(url: string): string {
  const m = url.match(
    /^((?:.*?\|)?)([a-zA-Z][a-zA-Z0-9-+.]*)(?:(:[^?#|]*)((?:[?#][^|]*)?))?$/,
  );
  if (m === null) {
    throw new Error(`Invalid URL: ${url}`);
  }
  const [, pipelinePrefix, scheme, path, queryAndFragment] = m;
  if (path === undefined) {
    return `${pipelinePrefix}${scheme}:`;
  }
  if (path === ":" || path.endsWith("/")) return url;
  return `${pipelinePrefix}${scheme}${path}/${queryAndFragment ?? ""}`;
}

export function finalPipelineUrlComponent(url: string) {
  // match is infallible
  const m = url.match(/.*?([^|]*)$/)!;
  return m[1];
}

export const schemePattern = /^(?:([a-zA-Z][a-zA-Z0-9-+.]*):)?(.*)$/;

export function parsePipelineUrlComponent(url: string): UrlWithParsedScheme {
  // schemePattern always matches
  const m = url.match(schemePattern)!;
  const scheme = m[1];
  const suffix = m[2];
  if (scheme === undefined) {
    return { url, scheme: url, suffix: undefined };
  } else {
    return { url, scheme: scheme, suffix };
  }
}

export const urlComponentPattern =
  /^(?:([a-zA-Z][a-zA-Z0-9-+.]*):)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export function parseUrlSuffix(suffix: string | undefined): {
  authorityAndPath: string | undefined;
  query: string | undefined;
  fragment: string | undefined;
} {
  if (suffix === undefined) {
    return {
      authorityAndPath: undefined,
      query: undefined,
      fragment: undefined,
    };
  }
  // Infallible pattern.
  const [, authorityAndPath, query, fragment] = suffix.match(
    /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/,
  )!;
  return {
    authorityAndPath,
    query: query ?? undefined,
    fragment: fragment ?? undefined,
  };
}

export interface UrlWithParsedScheme {
  // Full original URL.
  url: string;

  // Scheme (excluding ":").
  scheme: string;

  // Suffix following "<scheme>:", including initial "//" if present.
  suffix: string | undefined;
}

// Splits a URL containing multiple "|"-separate parts.
export function splitPipelineUrl(url: string): UrlWithParsedScheme[] {
  return url.split("|").map(parsePipelineUrlComponent);
}

export function pipelineUrlJoin(
  baseUrl: string,
  ...additionalParts: string[]
): string {
  // Strip off any ? or # parameters, since they are not part of the path.
  // Infallible pattern
  let [, base, queryAndFragment] = baseUrl.match(/^(.*?[^|?#]*)([^|]*)$/)!;
  for (let part of additionalParts) {
    if (part.startsWith("/")) {
      part = part.substring(1);
    }
    if (part === "") continue;
    base = kvstoreEnsureDirectoryPipelineUrl(base);
    base += encodePathForUrl(part);
  }
  return base + queryAndFragment;
}

export function joinPath(base: string, ...additionalParts: string[]) {
  for (let part of additionalParts) {
    if (part.startsWith("/")) {
      part = part.substring(1);
    }
    if (part === "") continue;
    base = ensurePathIsDirectory(base);
    base += part;
  }
  return base;
}

export function ensurePathIsDirectory(path: string) {
  if (!pathIsDirectory(path)) {
    path += "/";
  }
  return path;
}

export function ensureNoQueryOrFragmentParameters(url: UrlWithParsedScheme) {
  const { suffix } = url;
  if (suffix === undefined) return;
  if (suffix.match(/[#?]/)) {
    throw new Error(
      `Invalid URL ${url.url}: query parameters and/or fragment not supported`,
    );
  }
}

export function ensureEmptyUrlSuffix(url: UrlWithParsedScheme) {
  if (url.suffix) {
    throw new Error(
      `Invalid URL syntax ${JSON.stringify(url.url)}, expected "${url.scheme}:"`,
    );
  }
}

export function extractQueryAndFragment(url: string): {
  base: string;
  queryAndFragment: string;
} {
  const [, base, queryAndFragment] = url.match(/^(.*?[^|?#]*)([^|]*)$/)!;
  return { base, queryAndFragment };
}

// Resolves `relativePath` relative to `basePath`.
//
// Note that the parameters are both expected to be plain paths, not full URLs
// or URL pipelines.
export function resolveRelativePath(basePath: string, relativePath: string) {
  const origBasePath = basePath;
  if (basePath.endsWith("/")) {
    basePath = basePath.substring(0, basePath.length - 1);
  }
  for (const component of relativePath.split("/")) {
    if (component === "" || component === ".") {
      continue;
    }
    if (component === "..") {
      const prevSlash = basePath.lastIndexOf("/");
      if (prevSlash <= 0) {
        throw new Error(
          `Invalid relative path ${JSON.stringify(relativePath)} from base path ${JSON.stringify(origBasePath)}`,
        );
      }
      basePath = basePath.substring(0, prevSlash);
      continue;
    }
    if (basePath !== "") {
      basePath += "/";
    }
    basePath += component;
  }
  if (relativePath.endsWith("/")) {
    basePath += "/";
  }
  return basePath;
}

export function pathIsDirectory(path: string) {
  return path === "" || path.endsWith("/");
}

// Plain paths can have arbitrary characters, but to be included in a URL
// pipeline, special characters must be percent encoded.
export function encodePathForUrl(path: string) {
  return encodeURI(path).replace(
    /[?#@]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function joinBaseUrlAndPath(baseUrl: string, path: string) {
  const { base, queryAndFragment } = extractQueryAndFragment(baseUrl);
  return base + encodePathForUrl(path) + queryAndFragment;
}

export function getBaseHttpUrlAndPath(url: string) {
  const parsed = new URL(url);
  if (parsed.hash) {
    throw new Error("fragment not supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("basic auth credentials not supported");
  }
  return {
    baseUrl: `${parsed.origin}/${parsed.search}`,
    path: decodeURIComponent(parsed.pathname.substring(1)),
  };
}

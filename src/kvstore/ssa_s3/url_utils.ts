/**
 * @license
 * Copyright 2025 Google Inc.
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

export const SSA_SCHEME_PREFIX = "ssa+";

export function ensureSsaHttpsUrl(url: string): URL {
  if (!url.startsWith("ssa+https://")) {
    throw new Error(`Invalid URL ${JSON.stringify(url)}: expected ssa+https scheme`);
  }
  const httpUrl = url.substring(SSA_SCHEME_PREFIX.length);
  const parsed = new URL(httpUrl);
  if (parsed.hash) throw new Error("Fragment not supported in ssa+https URLs");
  if (parsed.username || parsed.password) throw new Error("Basic auth credentials are not supported in ssa+https URLs");
  return parsed;
}

export function getWorkerOriginAndDatasetPrefix(parsed: URL): { workerOrigin: string; datasetBasePrefix: string } {
  const workerOrigin = parsed.origin;
  const datasetBasePrefix = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return { workerOrigin, datasetBasePrefix };
}

export function getDisplayBase(url: string): string {
  const parsed = ensureSsaHttpsUrl(url);
  return `${SSA_SCHEME_PREFIX}${parsed.origin}/`;
}

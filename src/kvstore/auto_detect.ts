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

import type { KvStoreContext } from "#src/kvstore/context.js";
import { readKvStore } from "#src/kvstore/index.js";
import { pathIsDirectory } from "#src/kvstore/url.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export interface AutoDetectDirectoryOptions {
  url: string;
  fileNames: Set<string>;
  subDirectories: Set<string>;
  signal?: AbortSignal;
}

export interface AutoDetectMatch {
  suffix: string;
  description: string;
}

export interface AutoDetectDirectorySpec {
  fileNames?: Set<string>;
  subDirectories?: Set<string>;
  match: (options: AutoDetectDirectoryOptions) => Promise<AutoDetectMatch[]>;
}

export function simpleFilePresenceAutoDetectDirectorySpec(
  fileNames: Set<string>,
  match: AutoDetectMatch,
): AutoDetectDirectorySpec {
  return {
    fileNames,
    match: async (options) => {
      const detectedFileNames = options.fileNames;
      for (const fileName of fileNames) {
        if (detectedFileNames.has(fileName)) {
          return [match];
        }
      }
      return [];
    },
  };
}

export interface AutoDetectFileOptions {
  url: string;
  prefix: Uint8Array<ArrayBuffer>;
  suffix?: Uint8Array<ArrayBuffer>;
  totalSize: number | undefined;
  signal?: AbortSignal;
}

export interface AutoDetectFileSpec {
  prefixLength: number;
  suffixLength: number;
  match: (options: AutoDetectFileOptions) => Promise<AutoDetectMatch[]>;
}

function composeMatchFunctions<Options>(
  specs: {
    match: (options: Options) => Promise<AutoDetectMatch[]>;
  }[],
): (options: Options) => Promise<AutoDetectMatch[]> {
  return async (options: Options) => {
    const matches: AutoDetectMatch[] = [];
    const results = await Promise.allSettled(
      specs.map((spec) => spec.match(options)),
    );
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      matches.push(...result.value);
    }
    return matches;
  };
}

export function composeAutoDetectDirectorySpecs(
  specs: AutoDetectDirectorySpec[],
): AutoDetectDirectorySpec {
  const fileNames = new Set<string>();
  const subDirectories = new Set<string>();
  for (const spec of specs) {
    const { fileNames: curFileNames, subDirectories: curSubDirectories } = spec;
    if (curFileNames !== undefined) {
      for (const fileName of curFileNames) {
        fileNames.add(fileName);
      }
    }
    if (curSubDirectories !== undefined) {
      for (const subDirectory of curSubDirectories) {
        subDirectories.add(subDirectory);
      }
    }
  }
  return { fileNames, subDirectories, match: composeMatchFunctions(specs) };
}

export function composeAutoDetectFileSpecs(
  specs: AutoDetectFileSpec[],
): AutoDetectFileSpec {
  let prefixLength = 0;
  let suffixLength = 0;
  for (const spec of specs) {
    prefixLength = Math.max(prefixLength, spec.prefixLength);
    suffixLength = Math.max(suffixLength, spec.suffixLength);
  }
  return { prefixLength, suffixLength, match: composeMatchFunctions(specs) };
}

export class AutoDetectRegistry {
  directorySpecs: AutoDetectDirectorySpec[] = [];
  fileSpecs: AutoDetectFileSpec[] = [];
  private _directorySpec: AutoDetectDirectorySpec | undefined;
  private _fileSpec: AutoDetectFileSpec | undefined;

  registerDirectoryFormat(spec: AutoDetectDirectorySpec) {
    this.directorySpecs.push(spec);
    this._directorySpec = undefined;
  }

  registerFileFormat(spec: AutoDetectFileSpec) {
    this.fileSpecs.push(spec);
    this._fileSpec = undefined;
  }

  copyTo(registry: AutoDetectRegistry) {
    registry.directorySpecs.push(...this.directorySpecs);
    registry.fileSpecs.push(...this.fileSpecs);
    registry._fileSpec = undefined;
    registry._directorySpec = undefined;
  }

  get directorySpec() {
    return (
      this._directorySpec ?? (this._directorySpec = this.getDirectorySpec())
    );
  }

  private getDirectorySpec() {
    return composeAutoDetectDirectorySpecs(this.directorySpecs);
  }

  get fileSpec() {
    return this._fileSpec ?? (this._fileSpec = this.getFileSpec());
  }

  private getFileSpec() {
    const { fileSpecs } = this;
    const specs = [...fileSpecs];
    return composeAutoDetectFileSpecs(specs);
  }
}

export interface AutoDetectFormatOptions extends Partial<ProgressOptions> {
  kvStoreContext: KvStoreContext;
  url: string;
  autoDetectDirectory: () => AutoDetectDirectorySpec;
  autoDetectFile: () => AutoDetectFileSpec;
}

export async function autoDetectFormat(
  options: AutoDetectFormatOptions,
): Promise<{ matches: AutoDetectMatch[]; url: string }> {
  const kvStore = options.kvStoreContext.getKvStore(options.url);
  const { progressListener } = options;
  using _span =
    progressListener &&
    new ProgressSpan(progressListener, {
      message: `Auto-detecting data format at ${options.url}`,
    });
  if (!pathIsDirectory(kvStore.path) || kvStore.store.singleKey === true) {
    const statResponse = await kvStore.store.stat(kvStore.path, {
      signal: options.signal,
      progressListener: options.progressListener,
    });
    if (statResponse !== undefined) {
      // Match as file.
      const autoDetectFile = options.autoDetectFile();
      const { totalSize } = statResponse;
      let prefix: Uint8Array<ArrayBuffer>;
      let suffix: Uint8Array<ArrayBuffer> | undefined;
      if (totalSize !== undefined && autoDetectFile.suffixLength > 0) {
        if (
          totalSize <=
          autoDetectFile.prefixLength + autoDetectFile.suffixLength
        ) {
          // Perform a single read
          const readResponse = await readKvStore(kvStore.store, kvStore.path, {
            signal: options.signal,
            progressListener: options.progressListener,
            throwIfMissing: true,
          });
          prefix = suffix = new Uint8Array(
            await readResponse.response.arrayBuffer(),
          );
        } else {
          [prefix, suffix] = await Promise.all(
            [
              { offset: 0, length: autoDetectFile.prefixLength },
              {
                offset: totalSize - autoDetectFile.suffixLength,
                length: autoDetectFile.suffixLength,
              },
            ].map((byteRange) =>
              readKvStore(kvStore.store, kvStore.path, {
                signal: options.signal,
                progressListener: options.progressListener,
                throwIfMissing: true,
                byteRange,
              })
                .then((readResponse) => readResponse.response.arrayBuffer())
                .then((arrayBuffer) => new Uint8Array(arrayBuffer)),
            ),
          );
        }
      } else {
        prefix = new Uint8Array(
          await (
            await readKvStore(kvStore.store, kvStore.path, {
              signal: options.signal,
              progressListener: options.progressListener,
              throwIfMissing: true,
              byteRange: { offset: 0, length: autoDetectFile.prefixLength },
            })
          ).response.arrayBuffer(),
        );
      }
      return {
        matches: await autoDetectFile.match({
          url: options.url,
          prefix,
          suffix,
          totalSize,
          signal: options.signal,
        }),
        url: options.url,
      };
    }

    if (kvStore.store.singleKey === true) {
      return { matches: [], url: options.url };
    }
    kvStore.path += "/";
  }

  const autoDetectDirectory = options.autoDetectDirectory();
  const detectedFileNames = new Set<string>();
  await Promise.all(
    Array.from(autoDetectDirectory.fileNames ?? [], async (fileName) => {
      const response = await kvStore.store.stat(kvStore.path + fileName, {
        signal: options.signal,
        progressListener: options.progressListener,
      });
      if (response !== undefined) {
        detectedFileNames.add(fileName);
      }
    }),
  );
  const url = kvStore.store.getUrl(kvStore.path);
  const matches = await autoDetectDirectory.match({
    url,
    fileNames: detectedFileNames,
    subDirectories: new Set(),
    signal: options.signal,
  });
  return { matches, url };
}

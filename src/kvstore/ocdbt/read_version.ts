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

import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type {
  Config,
  ManifestWithVersionTree,
} from "#src/kvstore/ocdbt/manifest.js";
import {
  getResolvedManifest,
  getVersionTreeNode,
} from "#src/kvstore/ocdbt/metadata_cache.js";
import type { VersionSpecifier } from "#src/kvstore/ocdbt/version_specifier.js";
import { formatVersion } from "#src/kvstore/ocdbt/version_specifier.js";
import type {
  VersionNodeReference,
  BtreeGenerationReference,
  GenerationIndex,
  VersionQuery,
} from "#src/kvstore/ocdbt/version_tree.js";
import {
  compareVersionSpecToVersion,
  findLeafVersion,
  findLeafVersionIndexByLowerBound,
  findVersionNode,
  findVersionNodeIndexByLowerBound,
  findVersionNodeIndexByUpperBound,
  validateVersionTreeNodeReference,
} from "#src/kvstore/ocdbt/version_tree.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export async function getRoot(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  version: VersionSpecifier | undefined,
  options: Partial<ProgressOptions>,
): Promise<BtreeGenerationReference> {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "ocdbt:version",
    () => {
      const cache = new SimpleAsyncCache<
        { url: string; version: VersionSpecifier | undefined },
        BtreeGenerationReference
      >(sharedKvStoreContext.chunkManager.addRef(), {
        get: async ({ url, version }, progressOptions) => {
          const manifest = await getResolvedManifest(
            sharedKvStoreContext,
            url,
            progressOptions,
          );
          const root = await readVersion(
            sharedKvStoreContext,
            manifest,
            version,
            options,
          );
          if (root === undefined) {
            throw new Error(`Version ${formatVersion(version)} not found`);
          }
          return {
            data: root.ref,
            // BtreeGenerationReference is a tiny object, size may as well be 0
            size: 0,
          };
        },
        encodeKey: ({ url, version }) => {
          let versionString: string | undefined;
          if (version !== undefined) {
            versionString = formatVersion(version);
          }
          return JSON.stringify([url, versionString]);
        },
      });
      cache.registerDisposer(sharedKvStoreContext.addRef());
      return cache;
    },
  );
  return cache.get({ url, version }, options);
}

export async function readVersion(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  version: VersionQuery | undefined,
  options: Partial<ProgressOptions>,
): Promise<
  | { ref: BtreeGenerationReference; generationIndex: GenerationIndex }
  | undefined
> {
  const { versionTree } = manifest;
  if (version === undefined) {
    const { versionTreeNodes, inlineVersions } = versionTree;
    const index = inlineVersions.length - 1;
    return {
      ref: inlineVersions[index],
      generationIndex:
        (versionTreeNodes.at(-1)?.cumulativeNumGenerations ?? 0n) +
        BigInt(index),
    };
  }
  const { ref, generationIndex } = await findVersion(
    sharedKvStoreContext,
    manifest,
    version,
    options,
  );
  if (ref === undefined) return undefined;
  return { ref, generationIndex };
}

export async function findVersionIndexByLowerBound(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  version: VersionSpecifier,
  options: Partial<ProgressOptions>,
): Promise<GenerationIndex> {
  const { generationIndex } = await findVersionLowerBoundImpl(
    sharedKvStoreContext,
    manifest,
    version,
    options,
  );
  return generationIndex;
}

export async function findVersionIndexByUpperBound(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  version: VersionSpecifier,
  options: Partial<ProgressOptions>,
): Promise<GenerationIndex> {
  const { generationIndex } = await findVersionUpperBoundImpl(
    sharedKvStoreContext,
    manifest,
    version,
    options,
  );
  return generationIndex;
}

interface FindVersionImplOptions<Query> {
  isInline(
    config: Config,
    generationIndex: GenerationIndex,
    versions: BtreeGenerationReference[],
    query: Query,
  ): boolean;
  findInLeaf(
    config: Config,
    generationIndex: GenerationIndex,
    versions: BtreeGenerationReference[],
    query: Query,
  ): number;
  findInInterior(
    config: Config,
    generationIndex: GenerationIndex,
    versionNodes: VersionNodeReference[],
    query: Query,
  ): VersionNodeReference | undefined;
}

function findVersionImpl<Query>(options: FindVersionImplOptions<Query>): (
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  query: Query,
  options: Partial<ProgressOptions>,
) => Promise<{
  ref: BtreeGenerationReference | undefined;
  generationIndex: GenerationIndex;
}> {
  const { isInline, findInLeaf, findInInterior } = options;
  async function findVersion(
    sharedKvStoreContext: SharedKvStoreContextCounterpart,
    manifest: ManifestWithVersionTree,
    query: Query,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<{
    ref: BtreeGenerationReference | undefined;
    generationIndex: GenerationIndex;
  }> {
    const { config, versionTree } = manifest;
    const generationIndex =
      versionTree.versionTreeNodes.at(-1)?.cumulativeNumGenerations ?? 0n;
    const { inlineVersions } = versionTree;
    if (isInline(config, generationIndex, inlineVersions, query)) {
      const index = findInLeaf(config, generationIndex, inlineVersions, query);
      return {
        ref: inlineVersions[index],
        generationIndex: generationIndex + BigInt(index),
      };
    }
    const { versionTreeNodes } = versionTree;
    if (versionTreeNodes.length === 0) {
      return { ref: undefined, generationIndex: 0n };
    }
    const ref = findInInterior(config, 0n, versionTreeNodes, query);
    if (ref === undefined) return { ref: undefined, generationIndex: 0n };
    return await findInSubtree(
      sharedKvStoreContext,
      manifest.config,
      0n + ref.cumulativeNumGenerations - ref.numGenerations,
      ref,
      query,
      progressOptions,
    );
  }

  async function findInSubtree(
    sharedKvStoreContext: SharedKvStoreContextCounterpart,
    config: Config,
    generationIndex: GenerationIndex,
    ref: VersionNodeReference,
    query: Query,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<{
    ref: BtreeGenerationReference | undefined;
    generationIndex: GenerationIndex;
  }> {
    while (true) {
      const node = await getVersionTreeNode(
        sharedKvStoreContext,
        ref.location,
        progressOptions,
      );
      validateVersionTreeNodeReference(
        node,
        config,
        ref.generationNumber,
        ref.height,
        ref.numGenerations,
      );
      if (node.height === 0) {
        const entries = node.entries as BtreeGenerationReference[];
        const index = findInLeaf(config, generationIndex, entries, query);
        return {
          ref: entries[index],
          generationIndex: generationIndex + BigInt(index),
        };
      }
      const result = findInInterior(
        config,
        generationIndex,
        node.entries as VersionNodeReference[],
        query,
      );
      if (result === undefined) return { ref: undefined, generationIndex };
      ref = result;
      generationIndex += ref.cumulativeNumGenerations - ref.numGenerations;
    }
  }

  return findVersion;
}

function isVersionQueryInline(
  generationIndex: GenerationIndex,
  versions: BtreeGenerationReference[],
  version: VersionQuery,
): boolean {
  if ("generationIndex" in version) {
    return version.generationIndex >= generationIndex;
  }
  return compareVersionSpecToVersion(version, versions[0]) >= 0;
}

const findVersion = findVersionImpl<VersionQuery>({
  isInline(_config, generationIndex, versions, version) {
    return isVersionQueryInline(generationIndex, versions, version);
  },
  findInLeaf(_config, generationIndex, versions, version) {
    return findLeafVersion(generationIndex, versions, version);
  },
  findInInterior(config, generationIndex, versionNodes, version) {
    return findVersionNode(
      config.versionTreeArityLog2,
      generationIndex,
      versionNodes,
      version,
    );
  },
});

const findVersionLowerBoundImpl = findVersionImpl<VersionQuery>({
  isInline(_config, generationIndex, versions, version) {
    return isVersionQueryInline(generationIndex, versions, version);
  },
  findInLeaf(_config, generationIndex, versions, version) {
    return findLeafVersionIndexByLowerBound(generationIndex, versions, version);
  },
  findInInterior(config, generationIndex, versionNodes, version) {
    const index = findVersionNodeIndexByLowerBound(
      config.versionTreeArityLog2,
      generationIndex,
      versionNodes,
      version,
    );
    return versionNodes[index];
  },
});

const findVersionUpperBoundImpl = findVersionImpl<VersionQuery>({
  isInline(_config, generationIndex, versions, version) {
    return isVersionQueryInline(generationIndex, versions, version);
  },
  findInLeaf(_config, generationIndex, versions, version) {
    return findLeafVersionIndexByLowerBound(generationIndex, versions, version);
  },
  findInInterior(_config, generationIndex, versionNodes, version) {
    const index = findVersionNodeIndexByUpperBound(
      generationIndex,
      versionNodes,
      version,
    );
    return versionNodes[index];
  },
});

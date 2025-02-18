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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { ManifestWithVersionTree } from "#src/kvstore/ocdbt/manifest.js";
import { getVersionTreeNode } from "#src/kvstore/ocdbt/metadata_cache.js";
import type {
  BtreeGenerationReference,
  GenerationIndex,
  VersionNodeReference,
  VersionQuery,
} from "#src/kvstore/ocdbt/version_tree.js";
import {
  findLeafVersionIndexByLowerBound,
  findVersionNodeIndexByLowerBound,
  findVersionNodeIndexByUpperBound,
  validateVersionTreeNodeReference,
} from "#src/kvstore/ocdbt/version_tree.js";
import { bigintCompare } from "#src/util/bigint.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const DEBUG = false;

export interface ListVersionsOptions extends Partial<ProgressOptions> {
  inclusiveMin?: VersionQuery;
  exclusiveMax?: VersionQuery;
}

export async function listVersions(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  options: ListVersionsOptions,
): Promise<{
  generationIndex: GenerationIndex;
  versions: BtreeGenerationReference[];
}> {
  const { inclusiveMin, exclusiveMax } = options;
  if (DEBUG) {
    console.log("listVersions", inclusiveMin, exclusiveMax);
  }
  const resolvedInclusiveMin: VersionQuery =
    inclusiveMin === undefined ? { generationIndex: 0n } : inclusiveMin;
  const resolvedExclusiveMax: VersionQuery =
    exclusiveMax === undefined
      ? { generationIndex: manifest.versionTree.numGenerations }
      : exclusiveMax;
  const { config, versionTree } = manifest;
  const { versionTreeArityLog2 } = config;
  let minGenerationIndex: GenerationIndex | undefined;
  const results: BtreeGenerationReference[] = [];
  {
    const generationIndex =
      versionTree.versionTreeNodes.at(-1)?.cumulativeNumGenerations ?? 0n;
    visitLeafEntries(generationIndex, versionTree.inlineVersions);
    await visitInteriorEntries(0n, versionTree.versionTreeNodes);
  }

  function visitLeafEntries(
    generationIndex: GenerationIndex,
    versions: BtreeGenerationReference[],
  ) {
    const lower = findLeafVersionIndexByLowerBound(
      generationIndex,
      versions,
      resolvedInclusiveMin,
    );
    const upper = findLeafVersionIndexByLowerBound(
      generationIndex,
      versions,
      resolvedExclusiveMax,
    );
    const resultGenerationIndex = generationIndex + BigInt(lower);
    if (
      minGenerationIndex === undefined ||
      resultGenerationIndex < minGenerationIndex
    ) {
      minGenerationIndex = resultGenerationIndex;
    }
    for (let i = lower; i < upper; ++i) {
      results.push(versions[i]);
    }
  }

  async function visitInteriorEntries(
    generationIndex: GenerationIndex,
    versionNodes: VersionNodeReference[],
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const lower = findVersionNodeIndexByLowerBound(
      versionTreeArityLog2,
      generationIndex,
      versionNodes,
      resolvedInclusiveMin,
    );
    const upper = findVersionNodeIndexByUpperBound(
      generationIndex,
      versionNodes,
      resolvedExclusiveMax,
    );
    if (DEBUG) {
      console.log(
        "listVersions: visitInteriorEntries",
        resolvedInclusiveMin,
        resolvedExclusiveMax,
        `generationIndex=${generationIndex}`,
        `versionNodes.length=${versionNodes.length}`,
        lower,
        upper,
      );
    }
    const promises: Promise<void>[] = [];
    for (let i = lower; i < upper; ++i) {
      const ref = versionNodes[i];
      promises.push(
        visitNodeRef(
          generationIndex + ref.cumulativeNumGenerations - ref.numGenerations,
          ref,
        ),
      );
    }
    await Promise.all(promises);
  }

  async function visitNodeRef(
    generationIndex: GenerationIndex,
    ref: VersionNodeReference,
  ): Promise<void> {
    const node = await getVersionTreeNode(
      sharedKvStoreContext,
      ref.location,
      options,
    );
    validateVersionTreeNodeReference(
      node,
      config,
      ref.generationNumber,
      ref.height,
      ref.numGenerations,
    );
    if (node.height === 0) {
      visitLeafEntries(
        generationIndex,
        node.entries as BtreeGenerationReference[],
      );
    } else {
      await visitInteriorEntries(
        generationIndex,
        node.entries as VersionNodeReference[],
      );
    }
  }
  results.sort((a, b) => bigintCompare(a.generationNumber, b.generationNumber));
  return { generationIndex: minGenerationIndex ?? 0n, versions: results };
}

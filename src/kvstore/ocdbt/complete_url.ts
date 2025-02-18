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
import type {
  CompletionResult,
  KvStoreAdapterCompleteUrlOptions,
} from "#src/kvstore/context.js";
import { listVersions } from "#src/kvstore/ocdbt/list_versions.js";
import type { ManifestWithVersionTree } from "#src/kvstore/ocdbt/manifest.js";
import { getResolvedManifest } from "#src/kvstore/ocdbt/metadata_cache.js";
import {
  findVersionIndexByLowerBound,
  findVersionIndexByUpperBound,
} from "#src/kvstore/ocdbt/read_version.js";
import {
  formatCommitTime,
  parseCommitTimePrefix,
  parseVersion,
} from "#src/kvstore/ocdbt/version_specifier.js";
import type {
  BtreeGenerationReference,
  GenerationIndex,
} from "#src/kvstore/ocdbt/version_tree.js";
import { ensurePathIsDirectory } from "#src/kvstore/url.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

async function listVersionsLimited(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  manifest: ManifestWithVersionTree,
  minGenerationIndex: GenerationIndex,
  maxGenerationIndex: GenerationIndex,
  limit: GenerationIndex,
  options: Partial<ProgressOptions>,
): Promise<BtreeGenerationReference[]> {
  if (maxGenerationIndex <= minGenerationIndex + limit) {
    const { versions } = await listVersions(sharedKvStoreContext, manifest, {
      inclusiveMin: { generationIndex: minGenerationIndex },
      exclusiveMax: { generationIndex: maxGenerationIndex },
      ...options,
    });
    return versions;
  }

  const [{ versions: lowerVersions }, { versions: upperVersions }] =
    await Promise.all(
      [minGenerationIndex, maxGenerationIndex - limit / 2n].map(
        (generationIndex) =>
          listVersions(sharedKvStoreContext, manifest, {
            inclusiveMin: { generationIndex },
            exclusiveMax: { generationIndex: generationIndex + limit / 2n },
            ...options,
          }),
      ),
    );

  return [...lowerVersions, ...upperVersions];
}

export async function completeOcdbtUrl(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  options: KvStoreAdapterCompleteUrlOptions,
): Promise<CompletionResult | undefined> {
  const { url } = options;
  const suffix = url.suffix ?? "";
  if (suffix === "") {
    return {
      offset: 0,
      completions: [{ value: "@", description: "Version specifier" }],
    };
  }
  const m = suffix.match(/^@([^/]*)((?:\/|$).*)/);
  if (m === null) return undefined;
  const [, version, rest] = m;
  if (rest !== "") {
    parseVersion(version);
    return undefined;
  }

  const { base } = options;
  const baseUrl = base.store.getUrl(ensurePathIsDirectory(base.path));
  if (!version.startsWith("v")) {
    const [inclusiveMin, inclusiveMax] = parseCommitTimePrefix(version);
    const progressOptions = {
      signal: options.signal,
      progressListener: options.progressListener,
    };
    const manifest = await getResolvedManifest(
      sharedKvStoreContext,
      baseUrl,
      progressOptions,
    );
    const [minVersion, maxVersion] = await Promise.all([
      findVersionIndexByLowerBound(
        sharedKvStoreContext,
        manifest,
        { commitTime: inclusiveMin },
        progressOptions,
      ),
      findVersionIndexByUpperBound(
        sharedKvStoreContext,
        manifest,
        { commitTime: inclusiveMax + 1n },
        progressOptions,
      ),
    ]);
    const versions = await listVersionsLimited(
      sharedKvStoreContext,
      manifest,
      minVersion,
      maxVersion,
      100n,
      {
        signal: options.signal,
        progressListener: options.progressListener,
      },
    );
    const completions = versions.map((version) => ({
      value: `${formatCommitTime(version.commitTime)}/`,
      description: `v${version.generationNumber}`,
    }));
    completions.reverse();
    return { offset: 1, completions };
  }
  if (version === "v") {
    const { base } = options;
    const manifest = await getResolvedManifest(
      sharedKvStoreContext,
      base.store.getUrl(base.path),
      options,
    );
    const completions = manifest.versionTree.inlineVersions.map((ref) => ({
      value: `v${ref.generationNumber}/`,
      description: formatCommitTime(ref.commitTime),
    }));
    completions.reverse();
    return { offset: 1, completions };
  }
  return { offset: 1, completions: [{ value: `${version}/` }] };
}

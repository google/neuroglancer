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

import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import { coordinateSpacesEqual } from "#src/coordinate_transform.js";
import type {
  DataSource,
  DataSourceRegistry,
  DataSubsource,
  DataSubsourceEntry,
} from "#src/datasource/index.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { VolumeType } from "#src/sliceview/volume/base.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { DataType } from "#src/util/data_type.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressListener } from "#src/util/progress_listener.js";
import type { Fixture } from "#tests/fixtures/fixture.js";

export function getDatasourceSnapshot(datasource: DataSource) {
  return {
    subsources: Array.from(datasource.subsources, getSubsourceEntrySnapshot),
    modelTransform: getCoordinateSpaceTransformSnapshot(
      datasource.modelTransform,
    ),
    canonicalUrl: redactUrl(datasource.canonicalUrl),
    ...getKeys(datasource, ["canChangeModelSpaceRank"]),
  };
}

function getKeys<T>(x: T, keys: Array<keyof T>) {
  return Object.fromEntries(
    keys
      .map((key) => [key, x[key]])
      .filter(([_key, value]) => value !== undefined),
  );
}

function getCoordinateSpaceSnapshot(x: CoordinateSpace) {
  return getKeys(x, [
    "valid",
    "names",
    "units",
    "scales",
    "bounds",
    "coordinateArrays",
  ]);
}

function getCoordinateSpaceTransformSnapshot(x: CoordinateSpaceTransform) {
  const { rank } = x;
  const result: any = {};
  result.inputSpace = getCoordinateSpaceSnapshot(x.inputSpace);
  if (!coordinateSpacesEqual(x.inputSpace, x.outputSpace)) {
    result.outputSpace = getCoordinateSpaceSnapshot(x.outputSpace);
  }
  if (!matrix.isIdentity(x.transform, rank + 1, rank + 1)) {
    result.transform = getMatrixSnapshot(x.transform, rank + 1);
  }
  return result;
}

function getMatrixSnapshot(matrix: ArrayLike<number>, rows: number) {
  const result: number[][] = [];
  const cols = matrix.length / rows;
  for (let row = 0; row < rows; ++row) {
    const rowElements: number[] = [];
    for (let col = 0; col < cols; ++col) {
      rowElements[col] = matrix[col * rows + row];
    }
    result[row] = rowElements;
  }
  return result;
}

function getSubsourceEntrySnapshot(subsource: DataSubsourceEntry) {
  return {
    subsource: getSubsourceSnapshot(subsource.subsource),
    ...getKeys(subsource, [
      "default",
      "id",
      "modelSubspaceDimensionIndices",
      "subsourceToModelSubspaceTransform",
    ]),
  };
}

function getSubsourceSnapshot(subsource: DataSubsource) {
  if (subsource.volume) {
    return { volume: getVolumeSnapshot(subsource.volume) };
  }
  if (subsource.staticAnnotations) {
    return { staticAnnotations: subsource.staticAnnotations.toJSON() };
  }
  return {};
}

function getVolumeSnapshot(volume: MultiscaleVolumeChunkSource) {
  const sources = volume.getSources({
    multiscaleToViewTransform: matrix.createIdentity(Float32Array, volume.rank),
    displayRank: volume.rank,
    modelChannelDimensionIndices: [],
  });
  return {
    dataType: DataType[volume.dataType],
    volumeType: VolumeType[volume.volumeType],
    rank: volume.rank,
    sources: sources.map((sourceList) => sourceList.map(getSourceSnapshot)),
  };
}

function getSourceSnapshot(
  source: SliceViewSingleResolutionSource<VolumeChunkSource>,
) {
  const rank = source.chunkSource.spec.rank;
  let spec: any = VolumeChunkSource.encodeSpec(source.chunkSource.spec);
  spec = { ...spec, dataType: DataType[spec.dataType] };
  const parameters = { ...(source.chunkSource as any).parameters };
  delete parameters.metadata;
  if (parameters.url) {
    parameters.url = redactUrl(parameters.url as string);
  }
  const result: any = {
    ...getKeys(source, ["lowerClipBound", "upperClipBound"]),
    chunkSource: {
      parameters,
      spec,
    },
  };
  if (
    !matrix.isIdentity(source.chunkToMultiscaleTransform, rank + 1, rank + 1)
  ) {
    result.chunkToMultiscaleTransform = getMatrixSnapshot(
      source.chunkToMultiscaleTransform,
      rank + 1,
    );
  }
  return result;
}

function redactUrl(x: string | undefined): string | undefined {
  if (x === undefined) return undefined;
  return x.replaceAll(/(?<=http:\/\/localhost:)[0-9]+/g, "*");
}

export function loggingProgressListener(): ProgressListener {
  return {
    addSpan(span) {
      console.log(`[progress] ${span.message}`);
    },
    removeSpan(_span) {},
  };
}

export async function getDatasourceMetadata(
  dataSourceProvider: Fixture<DataSourceRegistry>,
  url: string,
) {
  const provider = await dataSourceProvider();
  const dataSource = await provider.get({
    url,
    globalCoordinateSpace: undefined as any,
    transform: undefined,
    progressListener: loggingProgressListener(),
  });
  return getDatasourceSnapshot(dataSource);
}

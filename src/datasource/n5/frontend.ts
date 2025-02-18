/**
 * @license
 * Copyright 2019 Google Inc.
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

/**
 * Supports single-resolution and multi-resolution N5 datasets
 *
 * The multi-resolution support is compatible with:
 *
 * https://github.com/saalfeldlab/n5-viewer
 * https://github.com/bigdataviewer/bigdataviewer-core/blob/master/BDV%20N5%20format.md
 *
 * https://github.com/janelia-cellmap/schemas/blob/master/multiscale.md
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateArray,
  CoordinateSpace,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { getKvStorePathCompletions } from "#src/datasource/kvstore_completions.js";
import {
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/n5/base.js";
import type { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import { simpleFilePresenceAutoDetectDirectorySpec } from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { CompletionResult, KvStoreContext } from "#src/kvstore/context.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  ensureNoQueryOrFragmentParameters,
  ensurePathIsDirectory,
  joinPath,
  kvstoreEnsureDirectoryPipelineUrl,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import {
  expectArray,
  parseArray,
  parseFixedLengthArray,
  verifyBoolean,
  verifyEnumString,
  verifyFinitePositiveFloat,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyPositiveInt,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { createHomogeneousScaleMatrix } from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { scaleByExp10, unitFromJson } from "#src/util/si_units.js";

class N5VolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  baseScaleIndex: number;

  modelSpace: CoordinateSpace;

  get rank() {
    return this.modelSpace.rank;
  }

  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public multiscaleMetadata: MultiscaleMetadata,
    public scales: (ScaleMetadata | undefined)[],
  ) {
    super(sharedKvStoreContext.chunkManager);
    let dataType: DataType | undefined;
    let baseScaleIndex: number | undefined;
    scales.forEach((scale, i) => {
      if (scale === undefined) return;
      if (baseScaleIndex === undefined) {
        baseScaleIndex = i;
      }
      if (dataType !== undefined && scale.dataType !== dataType) {
        throw new Error(
          `Scale s${i} has data type ${DataType[scale.dataType]} but expected ${
            DataType[dataType]
          }.`,
        );
      }
      dataType = scale.dataType;
    });
    if (dataType === undefined) {
      throw new Error("At least one scale must be specified.");
    }
    const baseDownsamplingInfo = scales[baseScaleIndex!]!;
    const baseScale = scales[baseScaleIndex!]!;
    this.dataType = dataType;
    this.volumeType = VolumeType.IMAGE;
    this.baseScaleIndex = baseScaleIndex!;
    const baseModelSpace = multiscaleMetadata.modelSpace;
    const { rank } = baseModelSpace;
    this.modelSpace = makeCoordinateSpace({
      names: baseModelSpace.names,
      scales: baseModelSpace.scales,
      units: baseModelSpace.units,
      boundingBoxes: [
        {
          transform: createHomogeneousScaleMatrix(
            Float64Array,
            baseDownsamplingInfo.downsamplingFactors,
            /*square=*/ false,
          ),
          box: {
            lowerBounds: new Float64Array(rank),
            upperBounds: new Float64Array(baseScale.size),
          },
        },
      ],
      coordinateArrays: baseModelSpace.coordinateArrays,
    });
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const { scales, rank } = this;
    return transposeNestedArrays(
      (scales.filter((scale) => scale !== undefined) as ScaleMetadata[]).map(
        (scale) => {
          const transform = createHomogeneousScaleMatrix(
            Float32Array,
            scale.downsamplingFactors,
          );
          return makeDefaultVolumeChunkSpecifications({
            rank,
            chunkToMultiscaleTransform: transform,
            dataType: scale.dataType,
            upperVoxelBound: scale.size,
            volumeType: this.volumeType,
            chunkDataSizes: [scale.chunkSize],
            volumeSourceOptions,
          }).map(
            (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
              chunkSource: this.chunkManager.getChunkSource(
                N5VolumeChunkSource,
                {
                  sharedKvStoreContext: this.sharedKvStoreContext,
                  spec,
                  parameters: {
                    url: scale.url,
                    encoding: scale.encoding,
                  },
                },
              ),
              chunkToMultiscaleTransform: transform,
            }),
          );
        },
      ),
    );
  }
}

interface MultiscaleMetadata {
  url: string;
  attributes: any;
  modelSpace: CoordinateSpace;
  scales: (
    | {
        readonly url: string;
        readonly downsamplingFactors?: Float64Array<ArrayBuffer>;
      }
    | undefined
  )[];
}
interface ScaleMetadata {
  url: string;
  dataType: DataType;
  encoding: VolumeChunkEncoding;
  size: Float32Array<ArrayBuffer>;
  chunkSize: Uint32Array<ArrayBuffer>;
  downsamplingFactors: Float64Array<ArrayBuffer>;
}

function parseScaleMetadata(
  url: string,
  obj: any,
  scaleIndex: number,
  downsamplingFactors?: Float64Array<ArrayBuffer>,
): ScaleMetadata {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, "dataType", (x) =>
    verifyEnumString(x, DataType),
  );
  const size = Float32Array.from(
    verifyObjectProperty(obj, "dimensions", (x) =>
      parseArray(x, verifyPositiveInt),
    ),
  );
  const chunkSize = verifyObjectProperty(obj, "blockSize", (x) =>
    parseFixedLengthArray(new Uint32Array(size.length), x, verifyPositiveInt),
  );

  let encoding: VolumeChunkEncoding | undefined;
  verifyOptionalObjectProperty(obj, "compression", (compression) => {
    encoding = verifyObjectProperty(compression, "type", (x) =>
      verifyEnumString(x, VolumeChunkEncoding),
    );
    if (
      encoding === VolumeChunkEncoding.GZIP &&
      verifyOptionalObjectProperty(
        compression,
        "useZlib",
        verifyBoolean,
        false,
      ) === true
    ) {
      encoding = VolumeChunkEncoding.ZLIB;
    }
  });
  if (encoding === undefined) {
    encoding = verifyObjectProperty(obj, "compressionType", (x) =>
      verifyEnumString(x, VolumeChunkEncoding),
    );
  }

  if (downsamplingFactors === undefined) {
    downsamplingFactors = verifyOptionalObjectProperty(
      obj,
      "downsamplingFactors",
      (x) =>
        parseFixedLengthArray(
          new Float64Array(size.length),
          x,
          verifyFinitePositiveFloat,
        ),
    );
    if (downsamplingFactors === undefined) {
      if (scaleIndex === 0) {
        downsamplingFactors = new Float64Array(size.length);
        downsamplingFactors.fill(1);
      } else {
        throw new Error("Expected downsamplingFactors attribute");
      }
    }
  }

  return { url, dataType, encoding, size, chunkSize, downsamplingFactors };
}

function getAllScales(
  sharedKvStoreContext: SharedKvStoreContext,
  multiscaleMetadata: MultiscaleMetadata,
  options: Partial<ProgressOptions>,
): Promise<(ScaleMetadata | undefined)[]> {
  return Promise.all(
    multiscaleMetadata.scales.map(async (scale, scaleIndex) => {
      if (scale === undefined) return undefined;
      const { attributes } = (await getAttributes(
        sharedKvStoreContext,
        scale.url,
        true,
        options,
      ))!;
      if (attributes === undefined) return undefined;
      try {
        return parseScaleMetadata(
          scale.url,
          attributes,
          scaleIndex,
          scale.downsamplingFactors,
        );
      } catch (e) {
        throw new Error(`Error parsing array metadata at ${scale.url}`, {
          cause: e,
        });
      }
    }),
  );
}

function getAttributesJsonUrls(
  kvStoreContext: KvStoreContext,
  url: string,
): { attributesJsonUrl: string; directoryUrl: string; relativePath: string }[] {
  const kvStore = kvStoreContext.getKvStore(url);
  const urls: {
    attributesJsonUrl: string;
    directoryUrl: string;
    relativePath: string;
  }[] = [];
  let path = kvStore.path.substring(0, kvStore.path.length - 1);
  while (true) {
    const directoryPath = ensurePathIsDirectory(path);
    urls.push({
      attributesJsonUrl: kvStore.store.getUrl(
        joinPath(path, "attributes.json"),
      ),
      directoryUrl: kvStore.store.getUrl(directoryPath),
      relativePath: kvStore.path.substring(directoryPath.length),
    });
    if (path === "") break;
    const index = path.lastIndexOf("/");
    path = path.substring(0, index);
  }
  return urls;
}

function getIndividualAttributesJson(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  required: boolean,
  options: Partial<ProgressOptions>,
): Promise<any> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "n5:attributes.json",
      url,
    },
    options,
    async (progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Reading n5 metadata from ${url}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(url, {
        ...progressOptions,
        throwIfMissing: required,
      });
      if (response === undefined) return undefined;
      const json = await response.response.json();
      try {
        return verifyObject(json);
      } catch (e) {
        throw new Error(`Error reading attributes from ${url}`, { cause: e });
      }
    },
  );
}

async function getAttributes(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  required: boolean,
  options: Partial<ProgressOptions>,
): Promise<
  { attributes: unknown; rootUrl: string; pathFromRoot: string } | undefined
> {
  const attributesJsonUrls = getAttributesJsonUrls(
    sharedKvStoreContext.kvStoreContext,
    url,
  );
  const metadata = await Promise.all(
    attributesJsonUrls.map((u, i) =>
      getIndividualAttributesJson(
        sharedKvStoreContext,
        u.attributesJsonUrl,
        required && i === attributesJsonUrls.length - 1,
        options,
      ),
    ),
  );
  const rootIndex = metadata.findLastIndex((x) => x !== undefined);
  if (rootIndex === -1) return undefined;
  metadata.reverse();
  const rootInfo = attributesJsonUrls[rootIndex];
  return {
    attributes: Object.assign({}, ...metadata.filter((x) => x !== undefined)),
    rootUrl: rootInfo.directoryUrl,
    pathFromRoot: rootInfo.relativePath,
  };
}

function verifyRank(existing: number, n: number) {
  if (existing !== -1 && n !== existing) {
    throw new Error(`Rank mismatch, received ${n} but expected ${existing}`);
  }
  return n;
}

function parseSingleResolutionDownsamplingFactors(obj: any) {
  return Float64Array.from(parseArray(obj, verifyFinitePositiveFloat));
}

function parseMultiResolutionDownsamplingFactors(obj: any) {
  const a = expectArray(obj);
  if (a.length === 0) throw new Error("Expected non-empty array");
  let rank = -1;
  const allFactors = parseArray(a, (x) => {
    const f = parseSingleResolutionDownsamplingFactors(x);
    rank = verifyRank(rank, f.length);
    return f;
  });
  return { all: allFactors, single: undefined, rank };
}

function parseDownsamplingFactors(obj: any) {
  const a = expectArray(obj);
  if (a.length === 0) throw new Error("Expected non-empty array");
  if (Array.isArray(a[0])) {
    return parseMultiResolutionDownsamplingFactors(a);
  }
  const f = parseSingleResolutionDownsamplingFactors(obj);
  return { all: undefined, single: f, rank: f.length };
}

const defaultAxes = ["x", "y", "z", "t", "c"];

function getDefaultAxes(rank: number) {
  const axes = defaultAxes.slice(0, rank);
  while (axes.length < rank) {
    axes.push(`d${axes.length + 1}`);
  }
  return axes;
}

async function getMultiscaleMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  attributes: any,
  progressOptions: ProgressOptions,
): Promise<MultiscaleMetadata> {
  verifyObject(attributes);
  let rank = -1;

  let scales = verifyOptionalObjectProperty(attributes, "resolution", (x) => {
    const scales = Float64Array.from(parseArray(x, verifyFinitePositiveFloat));
    rank = verifyRank(rank, scales.length);
    return scales;
  });
  let axes = verifyOptionalObjectProperty(attributes, "axes", (x) => {
    const names = parseArray(x, verifyString);
    rank = verifyRank(rank, names.length);
    return names;
  });
  let units = verifyOptionalObjectProperty(attributes, "units", (x) => {
    const units = parseArray(x, unitFromJson);
    rank = verifyRank(rank, units.length);
    return units;
  });
  let defaultUnit = { unit: "m", exponent: -9 };
  let singleDownsamplingFactors: Float64Array<ArrayBuffer> | undefined;
  let allDownsamplingFactors: Float64Array<ArrayBuffer>[] | undefined;
  verifyOptionalObjectProperty(attributes, "downsamplingFactors", (dObj) => {
    const { single, all, rank: curRank } = parseDownsamplingFactors(dObj);
    rank = verifyRank(rank, curRank);
    if (single !== undefined) {
      singleDownsamplingFactors = single;
    }
    if (all !== undefined) {
      allDownsamplingFactors = all;
    }
  });
  // Handle n5-viewer "pixelResolution" attribute
  verifyOptionalObjectProperty(attributes, "pixelResolution", (resObj) => {
    defaultUnit = verifyObjectProperty(resObj, "unit", unitFromJson);
    verifyOptionalObjectProperty(resObj, "dimensions", (scalesObj) => {
      scales = Float64Array.from(
        parseArray(scalesObj, verifyFinitePositiveFloat),
      );
      rank = verifyRank(rank, scales.length);
    });
  });
  // Handle n5-viewer "scales" attribute
  verifyOptionalObjectProperty(attributes, "scales", (scalesObj) => {
    const { all, rank: curRank } =
      parseMultiResolutionDownsamplingFactors(scalesObj);
    rank = verifyRank(rank, curRank);
    allDownsamplingFactors = all;
  });
  const dimensions = verifyOptionalObjectProperty(
    attributes,
    "dimensions",
    (x) => {
      const dimensions = parseArray(x, verifyPositiveInt);
      rank = verifyRank(rank, dimensions.length);
      return dimensions;
    },
  );

  if (rank === -1) {
    throw new Error("Unable to determine rank of dataset");
  }
  if (units === undefined) {
    units = new Array(rank);
    units.fill(defaultUnit);
  }
  if (scales === undefined) {
    scales = new Float64Array(rank);
    scales.fill(1);
  }
  for (let i = 0; i < rank; ++i) {
    scales[i] = scaleByExp10(scales[i], units[i].exponent);
  }
  // Handle coordinateArrays
  const coordinateArrays = new Array<CoordinateArray | undefined>(rank);
  if (axes !== undefined) {
    verifyOptionalObjectProperty(
      attributes,
      "coordinateArrays",
      (coordinateArraysObj) => {
        verifyObject(coordinateArraysObj);
        for (let i = 0; i < rank; ++i) {
          const name = axes![i];
          if (Object.prototype.hasOwnProperty.call(coordinateArraysObj, name)) {
            const labels = verifyStringArray(coordinateArraysObj[name]);
            coordinateArrays[i] = {
              explicit: false,
              labels,
              coordinates: Array.from(labels, (_, i) => i),
            };
            units![i] = { unit: "", exponent: 0 };
            scales![i] = 1;
          }
        }
      },
    );
  }
  if (axes === undefined) {
    axes = getDefaultAxes(rank);
  }
  const modelSpace = makeCoordinateSpace({
    rank,
    valid: true,
    names: axes,
    scales,
    units: units.map((x) => x.unit),
    coordinateArrays,
  });
  if (dimensions === undefined) {
    if (allDownsamplingFactors === undefined) {
      const scaleDirectories = await findScaleDirectories(
        sharedKvStoreContext,
        url,
        progressOptions,
      );
      if (scaleDirectories.length === 0) {
        throw new Error(
          "Not valid single-resolution or multi-resolution dataset",
        );
      }
      return {
        modelSpace,
        url,
        attributes,
        scales: scaleDirectories.map((name) => ({
          url: `${url}${name}/`,
          downsamplingFactors: undefined,
        })),
      };
    }
    return {
      modelSpace,
      url,
      attributes,
      scales: allDownsamplingFactors.map((f, i) => ({
        url: `${url}s${i}/`,
        downsamplingFactors: f,
      })),
    };
  }
  if (singleDownsamplingFactors === undefined) {
    singleDownsamplingFactors = new Float64Array(rank);
    singleDownsamplingFactors.fill(1);
  }
  return {
    modelSpace,
    url,
    attributes,
    scales: [{ url, downsamplingFactors: singleDownsamplingFactors }],
  };
}

async function findScaleDirectories(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  progressOptions: ProgressOptions,
): Promise<string[]> {
  const result = await sharedKvStoreContext.kvStoreContext.list(url, {
    responseKeys: "suffix",
    ...progressOptions,
  });
  const scaleDirectories: string[] = [];
  for (const directory of result.directories) {
    if (directory.match(/^s(?:0|[1-9][0-9]*)$/)) {
      const scale = Number(directory.substring(1));
      scaleDirectories[scale] = directory;
    }
  }
  return scaleDirectories;
}

export class N5DataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "n5";
  }
  get expectsDirectory() {
    return true;
  }
  get description() {
    return "N5 data source";
  }
  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    ensureNoQueryOrFragmentParameters(options.url);
    const url = kvstoreEnsureDirectoryPipelineUrl(
      pipelineUrlJoin(
        kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl),
        options.url.suffix ?? "",
      ),
    );
    const { sharedKvStoreContext } = options.registry;
    return options.registry.chunkManager.memoize.getAsync(
      { type: "n5:MultiscaleVolumeChunkSource", url },
      options,
      async (progressOptions) => {
        const attributeResult = await getAttributes(
          sharedKvStoreContext,
          url,
          false,
          progressOptions,
        );
        if (attributeResult === undefined) {
          throw new Error("N5 metadata not found");
        }
        const { attributes, rootUrl, pathFromRoot } = attributeResult;
        const multiscaleMetadata = await getMultiscaleMetadata(
          sharedKvStoreContext,
          url,
          attributes,
          progressOptions,
        );
        const scales = await getAllScales(
          sharedKvStoreContext,
          multiscaleMetadata,
          progressOptions,
        );
        const volume = new MultiscaleVolumeChunkSource(
          sharedKvStoreContext,
          multiscaleMetadata,
          scales,
        );
        return {
          canonicalUrl: `${rootUrl}|${options.url.scheme}:${pathFromRoot}`,
          modelTransform: makeIdentityTransform(volume.modelSpace),
          subsources: [
            {
              id: "default",
              default: true,
              url: undefined,
              subsource: { volume },
            },
            {
              id: "bounds",
              default: true,
              url: undefined,
              subsource: {
                staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
                  volume.modelSpace.bounds,
                ),
              },
            },
          ],
        };
      },
    );
  }

  async completeUrl(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<CompletionResult> {
    ensureNoQueryOrFragmentParameters(options.url);
    return getKvStorePathCompletions(options.registry.sharedKvStoreContext, {
      baseUrl: kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl),
      path: options.url.suffix ?? "",
      directoryOnly: true,
      signal: options.signal,
      progressListener: options.progressListener,
    });
  }
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerDirectoryFormat(
    simpleFilePresenceAutoDetectDirectorySpec(new Set(["attributes.json"]), {
      suffix: "n5:",
      description: "N5",
    }),
  );
}

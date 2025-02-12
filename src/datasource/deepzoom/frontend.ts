/**
 * @license
 * Copyright 2016 Google Inc., 2023 Gergely Csucs
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

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type {
  BoundingBox,
  CoordinateSpace,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  ImageTileEncoding,
  ImageTileSourceParameters,
} from "#src/datasource/deepzoom/base.js";
import type {
  DataSource,
  DataSubsourceEntry,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { ensureEmptyUrlSuffix } from "#src/kvstore/url.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyEnumString,
  verifyInt,
  verifyObject,
  verifyPositiveInt,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

/*export*/ class DeepzoomImageTileSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  ImageTileSourceParameters,
) {}

interface LevelInfo {
  width: number;
  height: number;
}

/*export*/ interface PyramidalImageInfo {
  levels: LevelInfo[];
  modelSpace: CoordinateSpace;
  overlap: number;
  tilesize: number;
  format: string;
  encoding: ImageTileEncoding;
}

/*export*/ function buildPyramidalImageInfo(
  metadata: DZIMetaData,
): PyramidalImageInfo {
  const { width, height, tilesize, overlap, format } = metadata;
  const encoding = verifyEnumString(format, ImageTileEncoding);
  const levelInfos = new Array<LevelInfo>();
  let w = width;
  let h = height;
  while (w > 1 || h > 1) {
    levelInfos.push({ width: w, height: h });
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
  }
  levelInfos.push({ width: w, height: h });

  const rank = 3;
  const scales = Float64Array.of(1 / 1e9, 1 / 1e9, 1);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = Float64Array.of(width, height, 3);
  const names = ["x", "y", "c^"];
  const units = ["m", "m", ""];

  const box: BoundingBox = { lowerBounds, upperBounds };
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {
    levels: levelInfos,
    modelSpace,
    overlap,
    tilesize,
    format,
    encoding,
  };
}

/*export*/ class DeepzoomPyramidalImageTileSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.UINT8;
  }

  get volumeType() {
    return VolumeType.IMAGE;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  url: string;

  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    url: string,
    public info: PyramidalImageInfo,
  ) {
    super(sharedKvStoreContext.chunkManager);
    this.url = url.substring(0, url.lastIndexOf(".")) + "_files";
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const { rank } = this;
    const chunkDataSizes = [
      Uint32Array.of(this.info.tilesize, this.info.tilesize, 3),
    ];
    return transposeNestedArrays(
      this.info.levels.map((levelInfo, index, array) => {
        const relativeScale = 1 << index;
        const stride = rank + 1;
        const chunkToMultiscaleTransform = new Float32Array(stride * stride);
        chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
        const { upperBounds: baseUpperBound } =
          this.info.modelSpace.boundingBoxes[0].box;
        const upperClipBound = new Float32Array(rank);
        for (let i = 0; i < 2; ++i) {
          chunkToMultiscaleTransform[stride * i + i] = relativeScale;
          upperClipBound[i] = baseUpperBound[i] / relativeScale;
        }
        chunkToMultiscaleTransform[stride * 2 + 2] = 1;
        upperClipBound[2] = baseUpperBound[2];
        return makeDefaultVolumeChunkSpecifications({
          rank,
          dataType: this.dataType,
          chunkToMultiscaleTransform,
          upperVoxelBound: Float32Array.of(
            levelInfo.width,
            levelInfo.height,
            3,
          ),
          volumeType: this.volumeType,
          chunkDataSizes,
          volumeSourceOptions,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(
              DeepzoomImageTileSource,
              {
                sharedKvStoreContext: this.sharedKvStoreContext,
                spec,
                parameters: {
                  url: `${this.url}/${array.length - 1 - index}/`,
                  encoding: this.info.encoding,
                  format: this.info.format,
                  overlap: this.info.overlap,
                  tilesize: this.info.tilesize,
                },
              },
            ),
            chunkToMultiscaleTransform,
            upperClipBound,
          }),
        );
      }),
    );
  }
}

interface DZIMetaData {
  width: number;
  height: number;
  tilesize: number;
  overlap: number;
  format: string;
}

function getDZIMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<DZIMetaData> {
  if (url.endsWith(".json") || url.includes(".json?")) {
    /* http://openseadragon.github.io/examples/tilesource-dzi/
     * JSON variant is a bit of a hack, it's not known how much it is in use for real.
     * The actual reason for not implementing it right now is the lack of CORS-enabled
     * test data.
     */
    throw new Error("DZI-JSON: OpenSeadragon hack not supported yet.");
  }
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "deepzoom:metadata",
      url,
    },
    options,
    async (progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Reading Deep Zoom metadata from ${url}`,
      });
      const { response } = await sharedKvStoreContext.kvStoreContext.read(url, {
        ...progressOptions,
        throwIfMissing: true,
      });
      const text = await response.text();
      const xml = new DOMParser().parseFromString(text, "text/xml");
      const image = xml.documentElement;
      const size = verifyObject(image.getElementsByTagName("Size").item(0));
      return {
        width: verifyPositiveInt(size.getAttribute("Width")),
        height: verifyPositiveInt(size.getAttribute("Height")),
        tilesize: verifyPositiveInt(
          verifyString(image.getAttribute("TileSize")),
        ),
        overlap: verifyInt(verifyString(image.getAttribute("Overlap"))),
        format: verifyString(image.getAttribute("Format")),
      };
    },
  );
}

function getImageDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  metadata: DZIMetaData,
): DataSource {
  const info = buildPyramidalImageInfo(metadata);
  const volume = new DeepzoomPyramidalImageTileSource(
    sharedKvStoreContext,
    url,
    info,
  );
  const { modelSpace } = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { volume },
    },
    {
      id: "bounds",
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
          modelSpace.bounds,
        ),
      },
    },
  ];
  return {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources,
    canonicalUrl: `${url}|deepzoom:`,
  };
}

export class DeepzoomDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "deepzoom";
  }
  get description() {
    return "Deep Zoom data source";
  }

  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    ensureEmptyUrlSuffix(options.url);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "deepzoom:get", url: options.kvStoreUrl },
      options,
      async (progressOptions): Promise<DataSource> => {
        const metadata = await getDZIMetadata(
          options.registry.sharedKvStoreContext,
          options.kvStoreUrl,
          progressOptions,
        );
        return getImageDataSource(
          options.registry.sharedKvStoreContext,
          options.kvStoreUrl,
          metadata,
        );
      },
    );
  }
}

async function detectFormat(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  const text = new TextDecoder().decode(options.prefix);
  const xml = new DOMParser().parseFromString(text, "text/xml");
  if (
    xml.documentElement.tagName === "Image" &&
    xml.documentElement.namespaceURI ===
      "http://schemas.microsoft.com/deepzoom/2009"
  ) {
    return [{ suffix: "deepzoom:", description: "Deep Zoom" }];
  }
  return [];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    prefixLength: 500,
    suffixLength: 0,
    match: detectFormat,
  });
}

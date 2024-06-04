/**
 * @license
 * Copyright 2016 Google Inc.
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
 * @file Support for displaying single NIfTI Zarr (https://github.com/lincbrain/linc-docs/blob/dd3411c15643df2662a26dee752a394dfc282872/dev/nifti_zarr_format.md)
 * files as volumes.
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  CompleteUrlOptions,
  DataSource,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { DataSourceProvider } from "#src/datasource/index.js";
import {
  getNiftiVolumeInfo,
} from "#src/datasource/nifti/frontend.ts";
import type { ZarrMultiscaleInfo } from "#src/datasource/zarr/frontend.ts";
import {
  getMetadata,
  resolveOmeMultiscale,
  getMultiscaleInfoForSingleArray,
  MultiscaleVolumeChunkSource
} from "#src/datasource/zarr/frontend.ts";
import "#src/datasource/zarr/codec/blosc/resolve.js";
import "#src/datasource/zarr/codec/zstd/resolve.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/crc32c/resolve.js";
import "#src/datasource/zarr/codec/gzip/resolve.js";
import "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import {
  parseDimensionSeparator,
} from "#src/datasource/zarr/metadata/parse.js";
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import { uncancelableToken } from "#src/util/cancellation.js";
import { completeHttpPath } from "#src/util/http_path_completion.js";
import {
  parseQueryStringParameters,
  verifyObject,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";
import {
  parseSpecialUrl,
} from "#src/util/special_protocol_request.js";


export class NiftiZarrDataSource extends DataSourceProvider {
  constructor(public zarrVersion: 2 | 3 | undefined = undefined) {
    super();
  }
  get description() {
    const versionStr =
      this.zarrVersion === undefined ? "" : ` v${this.zarrVersion}`;
    return `Nifti Zarr ${versionStr} data source`;
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    // Pattern is infallible.
    let [, providerUrl, query] =
      options.providerUrl.match(/([^?]*)(?:\?(.*))?$/)!;
    const parameters = parseQueryStringParameters(query || "");
    verifyObject(parameters);
    const dimensionSeparator = verifyOptionalObjectProperty(
      parameters,
      "dimension_separator",
      parseDimensionSeparator,
    );
    if (providerUrl.endsWith("/")) {
      providerUrl = providerUrl.substring(0, providerUrl.length - 1);
    }
    return options.chunkManager.memoize.getUncounted(
      {
        type: "zarr:MultiscaleVolumeChunkSource",
        providerUrl,
        dimensionSeparator,
      },
      async () => {
        const { url, credentialsProvider } = parseSpecialUrl(
          providerUrl,
          options.credentialsManager,
        );
        const metadata = await getMetadata(
          options.chunkManager,
          credentialsProvider,
          url,
          {
            zarrVersion: this.zarrVersion,
            explicitDimensionSeparator: dimensionSeparator,
          },
        );
        if (metadata === undefined) {
          throw new Error("No zarr metadata found");
        }
        let multiscaleInfo: ZarrMultiscaleInfo;
        if (metadata.nodeType === "group") {
          // May be an OME-zarr multiscale dataset.
          const multiscale = parseOmeMetadata(url, metadata.userAttributes);
          if (multiscale === undefined) {
            throw new Error("Neither array nor OME multiscale metadata found");
          }
          multiscaleInfo = await resolveOmeMultiscale(
            options.chunkManager,
            credentialsProvider,
            multiscale,
            {
              zarrVersion: metadata.zarrVersion,
              explicitDimensionSeparator: dimensionSeparator,
            },
          );
        } else {
          multiscaleInfo = getMultiscaleInfoForSingleArray(url, metadata);
        }
        const volumeZarr = new MultiscaleVolumeChunkSource(
          options.chunkManager,
          credentialsProvider,
          multiscaleInfo,
        );

        // nifti head stored separately
        const niftiUrl = url.concat("/nifti/0");
        const info = await getNiftiVolumeInfo(
          options.chunkManager,
          credentialsProvider,
          niftiUrl,
          uncancelableToken,
        );
        const box = {
          lowerBounds: new Float64Array(info.rank),
          upperBounds: Float64Array.from(info.volumeSize),
        };
        const inputSpace = makeCoordinateSpace({
          rank: info.rank,
          names: info.sourceNames,
          scales: info.sourceScales,
          units: info.units,
          boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
        });
        const outputSpace = makeCoordinateSpace({
          rank: info.rank,
          names: info.viewNames,
          scales: info.viewScales,
          units: info.units,
        });

        // the code in activateDataSubsources is really bad and requires you name the variable "volume"
        // could change the code in index.ts but this is how it is in neuroglancer so wanted to follow convention
        const volume = volumeZarr;

        return {
          // use tranformation from the nifti portion of header
          modelTransform: {
            sourceRank: info.rank,
            rank: info.rank,
            inputSpace,
            outputSpace,
            transform: info.transform,
          },
          subsources: [
            {
              id: "default",
              default: true,
              url: undefined,
              subsource: { volume },  // volume from zarr portion
            },
            {
              id: "bounds",
              default: true,
              url: undefined,
              subsource: {
                staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(volumeZarr.modelSpace.bounds),  // volume from zarr portion
              },
            },
          ],
        };
      },
    );
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
      options.credentialsManager,
      options.providerUrl,
      options.cancellationToken,
    );
  }
}

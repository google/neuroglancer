/**
 * @license
 * Copyright 2023 Google Inc.
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

import debounce from 'lodash/debounce';
import {CoordinateSpace, coordinateSpaceFromJson, coordinateSpacesEqual, coordinateSpaceToJson, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {ImageUserLayer} from 'neuroglancer/image_user_layer';
import {UserLayer} from 'neuroglancer/layer';
import {RenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {getFillValueArray, UncompressedVolumeChunk} from 'neuroglancer/sliceview/uncompressed_chunk_format';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SliceViewVolumeRenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {CancellationToken, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {DataType} from 'neuroglancer/util/data_type';
import {RefCounted} from 'neuroglancer/util/disposable';
import {valueOrThrow} from 'neuroglancer/util/error';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyInt, verifyIntegerArray, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {MessageSeverity} from 'neuroglancer/util/message_list';
import {Signal} from 'neuroglancer/util/signal';
import {Viewer} from 'neuroglancer/viewer';

enum RequestKind {
  VOLUME_CHUNK,
  VOLUME_INFO,
}

interface VolumeInfoRequest {
  kind: RequestKind.VOLUME_INFO;
  id: string;
  layer: string;
  coordinateSpace: CoordinateSpace|undefined;
}

interface VolumeInfo {
  dimensions: CoordinateSpace;
  // order[i] specifies the logical dimension corresponding to the physical (C order) dimension `i`.
  order: number[];
  chunkShape: number[];
  gridOrigin: number[];
  lowerBound: number[];
  upperBound: number[];
  dataType: DataType;
}

interface VolumeChunkRequest {
  kind: RequestKind.VOLUME_CHUNK;
  id: string;
  layer: string;
  volumeInfo: VolumeInfo;
  chunkGridPosition: number[];
}

type VolumeRequest = VolumeInfoRequest|VolumeChunkRequest;

function parseVolumeRequests(obj: unknown): VolumeRequest[] {
  if (obj === undefined) return [];
  return parseArray(obj, parseVolumeRequest);
}

function volumeInfoEqual(a: VolumeInfo, b: VolumeInfo): boolean {
  return coordinateSpacesEqual(a.dimensions, b.dimensions) && arraysEqual(a.order, b.order) &&
      arraysEqual(a.chunkShape, b.chunkShape) && arraysEqual(a.gridOrigin, b.gridOrigin) &&
      arraysEqual(a.lowerBound, b.lowerBound) && arraysEqual(a.upperBound, b.upperBound) &&
      a.dataType === b.dataType;
}

function parseVolumeInfo(obj: unknown): VolumeInfo {
  const dimensions = verifyObjectProperty(obj, 'dimensions', coordinateSpaceFromJson);
  const order = verifyObjectProperty(obj, 'order', verifyIntegerArray);
  const chunkShape = verifyObjectProperty(obj, 'chunkShape', verifyIntegerArray);
  const gridOrigin = verifyObjectProperty(obj, 'gridOrigin', verifyIntegerArray);
  const lowerBound = verifyObjectProperty(obj, 'lowerBound', verifyIntegerArray);
  const upperBound = verifyObjectProperty(obj, 'upperBound', verifyIntegerArray);
  const dataType =
      verifyObjectProperty(obj, 'dataType', value => verifyEnumString(value, DataType));
  return {dimensions, order, chunkShape, gridOrigin, lowerBound, upperBound, dataType};
}

function volumeInfoToJson(info: VolumeInfo) {
  return {
    dimensions: coordinateSpaceToJson(info.dimensions),
    order: info.order,
    chunkShape: info.chunkShape,
    gridOrigin: info.gridOrigin,
    lowerBound: info.lowerBound,
    upperBound: info.upperBound,
    dataType: DataType[info.dataType].toLowerCase(),
  };
}

function parseVolumeRequest(obj: unknown): VolumeRequest {
  verifyObject(obj);
  const id = verifyObjectProperty(obj, 'id', verifyString);
  const layer = verifyObjectProperty(obj, 'layer', verifyString);
  const kind = verifyObjectProperty(obj, 'kind', kind => verifyEnumString(kind, RequestKind));
  switch (kind) {
    case RequestKind.VOLUME_INFO: {
      const coordinateSpace =
          verifyOptionalObjectProperty(obj, 'dimensions', coordinateSpaceFromJson);
      return {id, layer, kind, coordinateSpace};
    }
    case RequestKind.VOLUME_CHUNK: {
      const volumeInfo = verifyObjectProperty(obj, 'volumeInfo', parseVolumeInfo);
      const chunkGridPosition = verifyObjectProperty(
          obj, 'chunkGridPosition',
          value => parseFixedLengthArray(
              new Array<number>(volumeInfo.dimensions.rank), value, verifyInt));
      return {id, layer, kind, volumeInfo, chunkGridPosition};
    }
  }
}

function getDefaultCoordinateSpace(
    userLayer: UserLayer, renderLayer: SliceViewVolumeRenderLayer): CoordinateSpace {
  const transform = valueOrThrow(renderLayer.transform.value);
  const names = transform.layerDimensionNames;
  const {rank} = transform;
  const scales = new Float64Array(rank);
  const units = new Array<string>(rank);
  const copyScalesAndUnits = (toLayerDimensions: readonly number[], fromSpace: CoordinateSpace) => {
    toLayerDimensions.forEach((layerDimension, otherDimension) => {
      if (layerDimension === -1) return;
      scales[layerDimension] = fromSpace.scales[otherDimension];
      units[layerDimension] = fromSpace.units[otherDimension];
    });
  };
  copyScalesAndUnits(
      transform.localToRenderLayerDimensions, userLayer.managedLayer.localCoordinateSpace.value);
  copyScalesAndUnits(
      transform.channelToRenderLayerDimensions, renderLayer.channelCoordinateSpace.value);
  copyScalesAndUnits(
      transform.globalToRenderLayerDimensions,
      userLayer.managedLayer.manager.root.coordinateSpace.value);
  return makeCoordinateSpace({names, scales, units});
}

function getDimensionPermutation(sourceNames: readonly string[], targetNames: readonly string[]) {
  const sourceRank = sourceNames.length;
  const permutation = new Array<number>(sourceRank);
  for (let sourceDim = 0; sourceDim < sourceRank; ++sourceDim) {
    const sourceName = sourceNames[sourceDim];
    const targetDim = targetNames.indexOf(sourceName);
    permutation[sourceDim] = targetDim;
  }
  return permutation;
}

function getChunkToRenderLayerTransform(
    source: SliceViewSingleResolutionSource<VolumeChunkSource>, transform: RenderLayerTransform,
    renderLayerScales: Float64Array, requestedScales: Float64Array) {
  const {rank, unpaddedRank} = transform;
  const chunkToLayerTransform = new Float32Array((rank + 1) ** 2);
  matrix.multiply(
      chunkToLayerTransform, rank + 1, source.chunkToMultiscaleTransform, unpaddedRank + 1,
      transform.modelToRenderLayerTransform, rank + 1, unpaddedRank + 1, unpaddedRank + 1,
      unpaddedRank + 1);
  if (unpaddedRank !== rank) {
    matrix.copy(
        chunkToLayerTransform.subarray(rank + 1 * (unpaddedRank + 1) + unpaddedRank + 1), rank + 1,
        transform.modelToRenderLayerTransform.subarray(
            rank + 1 * (unpaddedRank + 1) + unpaddedRank + 1),
        rank + 1, rank - unpaddedRank, rank - unpaddedRank);
  }
  for (let row = 0; row < rank; ++row) {
    const factor = renderLayerScales[row] / requestedScales[row];
    for (let col = 0; col <= rank; ++col) {
      chunkToLayerTransform[col * (rank + 1) + row] *= factor;
    }
  }
  return chunkToLayerTransform;
}

function checkSourceMatch(
    source: SliceViewSingleResolutionSource<VolumeChunkSource>, transform: RenderLayerTransform,
    modelToRequestDimension: readonly number[], renderLayerScales: Float64Array,
    requestedScales: Float64Array): {translation: number[], chunkToRequestDimension: number[]}|
    null {
  const {rank, unpaddedRank} = transform;
  const chunkToLayerTransform =
      getChunkToRenderLayerTransform(source, transform, renderLayerScales, requestedScales);
  const chunkToRequestDimension = new Array<number>(unpaddedRank);
  chunkToRequestDimension.fill(-1);
  const chunkDimSeen = new Array<boolean>(rank);
  const layerDimSeen = new Array<boolean>(rank);
  const translation = new Array<number>(rank);
  for (let layerDim = 0; layerDim < rank; ++layerDim) {
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const val = chunkToLayerTransform[chunkDim * (rank + 1) + layerDim];
      if (val === 0) continue;
      if (val !== 1) {
        return null;
      }
      if (chunkDimSeen[chunkDim] !== undefined || layerDimSeen[layerDim] !== undefined) {
        throw new Error(`Non-invertible transform`);
      }
      chunkDimSeen[chunkDim] = true;
      layerDimSeen[layerDim] = true;
      if (chunkDim > unpaddedRank) continue;
      const requestDim = modelToRequestDimension[layerDim];
      if (requestDim === -1) {
        throw new Error(`Missing request dimension`);
      }
      chunkToRequestDimension[chunkDim] = requestDim;
    }
    // Check translation
    let translationCoeff = chunkToLayerTransform[rank * (rank + 1) + layerDim];
    if (Number.isInteger(translationCoeff + 0.5)) {
      translationCoeff += 0.5;
    } else if (!Number.isInteger(translationCoeff)) {
      throw new Error(`Non-integer origin`);
    }
    translation[layerDim] = translationCoeff;
  }
  return {chunkToRequestDimension, translation};
}

function findMatchingSource(
    sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][],
    transform: RenderLayerTransform, modelToRequestDimension: readonly number[],
    renderLayerScales: Float64Array, requestedScales: Float64Array): {
  source: SliceViewSingleResolutionSource<VolumeChunkSource>,
  translation: number[],
  chunkToRequestDimension: number[]
}|null {
  for (const scales of sources) {
    for (const source of scales) {
      const match = checkSourceMatch(
          source, transform, modelToRequestDimension, renderLayerScales, requestedScales);
      if (match !== null) {
        return {source, ...match};
      }
    }
  }
  return null;
}

export class VolumeRequestHandler extends RefCounted {
  requestState = new TrackableValue<VolumeRequest[]>([], parseVolumeRequests);
  sendVolumeInfoResponseRequested = new Signal<(requestId: string, info: unknown) => void>();
  sendVolumeChunkResponseRequested = new Signal<(requestId: string, response: unknown) => void>();

  private alreadyHandledRequests = new Map<string, CancellationTokenSource>();
  private debouncedMaybeHandleRequests =
      this.registerCancellable(debounce(() => this.maybeHandleRequests(), 0));
  constructor(public viewer: Viewer) {
    super();
    this.registerDisposer(viewer.layerManager.layersChanged.add(this.debouncedMaybeHandleRequests));
    this.registerDisposer(this.requestState.changed.add(this.debouncedMaybeHandleRequests));
  }

  private maybeHandleRequests() {
    const currentRequests = this.requestState.value;
    if (currentRequests.length === 0) return;
    const seenRequests = new Set<string>();
    const {alreadyHandledRequests} = this;
    for (const request of this.requestState.value) {
      const {id} = request;
      seenRequests.add(id);
      if (alreadyHandledRequests.has(id)) continue;
      const source = new CancellationTokenSource();
      try {
        if (!this.maybeHandleRequest(request, source)) {
          continue;
        }
      } catch (e) {
        if (request.kind === RequestKind.VOLUME_INFO) {
          this.sendVolumeInfoResponseRequested.dispatch(request.id, {error: e.message});
        }
      }
      alreadyHandledRequests.set(id, source);
    }

    for (const [requestId, cancellationSource] of alreadyHandledRequests) {
      if (!seenRequests.has(requestId)) {
        cancellationSource.cancel();
        alreadyHandledRequests.delete(requestId);
      }
    }
  }

  private maybeHandleRequest(request: VolumeRequest, cancellationToken: CancellationToken):
      boolean {
    const layer = this.viewer.layerManager.getLayerByName(request.layer);
    if (layer === undefined) {
      throw new Error(`Invalid layer`);
    }
    const userLayer = layer.layer;
    if (!layer.isReady()) {
      if (userLayer !== null) {
        for (const dataSource of userLayer.dataSources) {
          for (const message of dataSource.messages) {
            if (message.severity === MessageSeverity.error) {
              throw new Error(message.message);
            }
          }
        }
      }
      return false;
    }
    if (!(userLayer instanceof ImageUserLayer) && !(userLayer instanceof SegmentationUserLayer)) {
      throw new Error(`Invalid layer type: ${userLayer!.type}`);
    }
    const renderLayers = userLayer.renderLayers.filter(
                             renderLayer => renderLayer instanceof SliceViewVolumeRenderLayer) as
        SliceViewVolumeRenderLayer[];
    if (renderLayers.length !== 1) {
      throw new Error(`Layer has ${renderLayers.length} render layers, expected exactly 1`);
    }

    const renderLayer = renderLayers[0];
    const transform = valueOrThrow(renderLayer.transform.value);
    const renderLayerCoordinateSpace = getDefaultCoordinateSpace(userLayer, renderLayer);
    const {multiscaleSource} = renderLayer;

    let coordinateSpace: CoordinateSpace;
    if (request.kind === RequestKind.VOLUME_INFO) {
      if (request.coordinateSpace === undefined) {
        coordinateSpace = renderLayerCoordinateSpace;
      } else {
        coordinateSpace = request.coordinateSpace;
      }
    } else {
      coordinateSpace = request.volumeInfo.dimensions;
    }

    // Map coordinateSpace to model dimensions
    const modelToRequestDimension =
        getDimensionPermutation(transform.layerDimensionNames, coordinateSpace.names);

    const sources = multiscaleSource.getSources({
      discreteValues: true,
      displayRank: multiscaleSource.rank,
      modelChannelDimensionIndices: [],
      multiscaleToViewTransform: matrix.createIdentity(Float32Array, multiscaleSource.rank),
    });

    const match = findMatchingSource(
        sources, transform, modelToRequestDimension, renderLayerCoordinateSpace.scales,
        coordinateSpace.scales);
    if (match === null) {
      throw new Error(`No matching source`);
    }

    const {rank} = coordinateSpace;
    const {unpaddedRank} = transform;

    const {chunkToRequestDimension, source, translation} = match;

    const chunkShape = new Array<number>(rank);
    const gridOrigin = new Array<number>(rank);
    const lowerBound = new Array<number>(rank);
    const upperBound = new Array<number>(rank);
    const physicalToLogicalDimension = new Array<number>(rank);
    chunkShape.fill(1);
    const {spec} = source.chunkSource;
    for (let i = 0; i < rank; ++i) {
      gridOrigin[i] = translation[i];
      lowerBound[i] = translation[i];
      upperBound[i] = lowerBound[i] + 1;
      physicalToLogicalDimension[rank - i - 1] = i;
    }
    for (let chunkDim = 0; chunkDim < unpaddedRank; ++chunkDim) {
      const requestDim = chunkToRequestDimension[chunkDim];
      if (requestDim === -1) continue;
      physicalToLogicalDimension[rank - chunkDim - 1] = requestDim;
      chunkShape[requestDim] = spec.chunkDataSize[chunkDim];
      gridOrigin[requestDim] += spec.baseVoxelOffset[chunkDim];
      lowerBound[requestDim] +=
          Math.floor((source.lowerClipBound ?? spec.lowerVoxelBound)[chunkDim]);
      upperBound[requestDim] = translation[requestDim] +
          Math.ceil((source.upperClipBound ?? spec.upperVoxelBound)[chunkDim]);
    }
    const info = {
      dimensions: coordinateSpace,
      order: physicalToLogicalDimension,
      chunkShape,
      gridOrigin,
      lowerBound,
      upperBound,
      dataType: multiscaleSource.dataType,
    };

    if (request.kind === RequestKind.VOLUME_INFO) {
      this.sendVolumeInfoResponseRequested.dispatch(request.id, volumeInfoToJson(info));
      return true;
    }

    if (!volumeInfoEqual(request.volumeInfo, info)) {
      throw new Error(`Volume info mismatch`);
    }

    const chunkGridPosition = new Float32Array(unpaddedRank);
    for (let chunkDim = 0; chunkDim < unpaddedRank; ++chunkDim) {
      const requestDim = chunkToRequestDimension[chunkDim];
      if (requestDim === -1) continue;
      chunkGridPosition[chunkDim] = request.chunkGridPosition[requestDim];
    }

    (async () => {
      let response;
      try {
        response = await source.chunkSource.fetchChunk(
            chunkGridPosition, (chunk: UncompressedVolumeChunk) => {
              let data = (chunk as UncompressedVolumeChunk).data;
              let isFillValue = false;
              if (data === null) {
                const {fillValue, dataType} = chunk.source.spec;
                const array = getFillValueArray(dataType, fillValue);
                data = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
                isFillValue = true;
              }
              return {
                data,
                isFillValue,
                dtype: DataType[info.dataType].toLowerCase(),
                chunkDataSize: Array.from(chunk.chunkDataSize),
                order: info.order,
              };
            }, cancellationToken);
      } catch (e) {
        response = {error: e.message};
      }
      this.sendVolumeChunkResponseRequested.dispatch(request.id, response);
    })();
    return true;
  }
}

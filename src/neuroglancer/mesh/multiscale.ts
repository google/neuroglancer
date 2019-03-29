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

import {binarySearchLowerBound} from 'neuroglancer/util/array';
import {isAABBVisible, mat4, vec3} from 'neuroglancer/util/geom';
import {zorder3LessThan} from 'neuroglancer/util/zorder';

export interface MultiscaleMeshManifest {
  /**
   * Size of finest-resolution (base) chunk in object coordinates.
   */
  chunkShape: vec3;

  /**
   * Starting corner position of (0, 0, 0) chunk in object coordinates.
   */
  chunkGridSpatialOrigin: vec3;

  /**
   * Axis-aligned bounding box lower bound of object in object coordinates to use for clipping and
   * level-of-detail calculations.
   */
  clipLowerBound: vec3;

  /**
   * Axis-aligned bounding box upper bound of object in object coordinates to use for clipping and
   * level-of-detail calculations.
   */
  clipUpperBound: vec3;

  /**
   * Specifies the number of levels of detail (as `lodScales.length`), and the resolution in object
   * coordinates for each level of detail.  If `lodScales[lod] === 0`, then level-of-detail `lod`
   * does not exist.
   *
   * Level of detail `0` is the finest resolution.
   *
   * It must be the case that `(c >>> lodScales.length) == 0` for all coordinates in
   * `chunkCoordinates`.
   *
   * The non-zero values must be non-decreasing.
   *
   * For each chunk, the chosen `lod` is the largest value such that
   * `lodScales[lod] <= detailCutoff * pixelSize`, where `pixelSize` is the maximum spatial distance
   * spanned by a single viewport pixel within the projected image of the chunk.
   */
  lodScales: number[];

  /**
   * Row-major array of shape (n, 3) specifying the chunk coordinates (in units of finest-resolution
   * chunks, not spatial units) of the finest-resolution chunks that are available.  The chunk
   * coordinates of each lower resolution are obtained by right-shifting the coordinates by the
   * level of detail index.
   *
   * The chunk coordinates must be sorted by morton index.
   */
  chunkCoordinates: Uint32Array;
}

function getChunkEndIndex(
    x: number, y: number, z: number, lod: number, startIndex: number, endIndexBound: number,
    chunkCoordinates: Uint32Array) {
  endIndexBound = Math.min(endIndexBound, startIndex + 2 ** (lod * 3));
  const lodMask = ~0 << lod >>> 0;
  return binarySearchLowerBound(
      startIndex, endIndexBound,
      i => zorder3LessThan(
          x, y, z, chunkCoordinates[i * 3] & lodMask, chunkCoordinates[i * 3 + 1] & lodMask,
          chunkCoordinates[i * 3 + 2] & lodMask));
}

/**
 * @param detailCutoff Factor by which the spatial resolution of the mesh may be worse than the
 *     spatial resolution of a single viewport pixel.  For example, a value of 10 means that if a
 *     given portion of the object will be rendered such that a pixel corresponds to 50 nm, then a
 *     mesh level of detail down to 500 nm will be requested for that portion of the object.
 */
export function getDesiredMultiscaleMeshChunks(
    manifest: MultiscaleMeshManifest, modelViewProjection: mat4, clippingPlanes: Float32Array,
    detailCutoff: number, viewportWidth: number, viewportHeight: number,
    callback: (lod: number, beginIndex: number, endIndex: number, renderScale: number) => void) {
  const {chunkCoordinates, lodScales, chunkGridSpatialOrigin, chunkShape} = manifest;
  const maxLod = lodScales.length - 1;
  const m00 = modelViewProjection[0], m01 = modelViewProjection[4], m02 = modelViewProjection[8],
        m10 = modelViewProjection[1], m11 = modelViewProjection[5], m12 = modelViewProjection[9],
        m30 = modelViewProjection[3], m31 = modelViewProjection[7], m32 = modelViewProjection[11],
        m33 = modelViewProjection[15];

  const minWXcoeff = m30 > 0 ? 0 : 1;
  const minWYcoeff = m31 > 0 ? 0 : 1;
  const minWZcoeff = m32 > 0 ? 0 : 1;


  const nearA = clippingPlanes[4 * 4], nearB = clippingPlanes[4 * 4 + 1],
        nearC = clippingPlanes[4 * 4 + 2], nearD = clippingPlanes[4 * 4 + 3];

  function getPointW(x: number, y: number, z: number) {
    return m30 * x + m31 * y + m32 * z + m33;
  }

  function getBoxW(
      xLower: number, yLower: number, zLower: number, xUpper: number, yUpper: number,
      zUpper: number) {
    return getPointW(
        xLower + minWXcoeff * (xUpper - xLower), yLower + minWYcoeff * (yUpper - yLower),
        zLower + minWZcoeff * (zUpper - zLower));
  }

  /**
   * Minimum value of w within clipping frustrum (under the assumption that the minimum value is
   * occurs occurs on the near clipping plane).
   */
  const minWClip = getPointW(-nearD * nearA, -nearD * nearB, -nearD * nearC);

  const objectXLower = manifest.clipLowerBound[0], objectYLower = manifest.clipLowerBound[1],
        objectZLower = manifest.clipLowerBound[2];
  const objectXUpper = manifest.clipUpperBound[0], objectYUpper = manifest.clipUpperBound[1],
        objectZUpper = manifest.clipUpperBound[2];

  const xScale = Math.sqrt((m00 * viewportWidth) ** 2 + (m10 * viewportHeight) ** 2);
  const yScale = Math.sqrt((m01 * viewportWidth) ** 2 + (m11 * viewportHeight) ** 2);
  const zScale = Math.sqrt((m02 * viewportWidth) ** 2 + (m12 * viewportHeight) ** 2);

  const scaleFactor = Math.max(xScale, yScale, zScale);

  function handleChunk(
      lod: number, chunkIndex: number, chunkEndIndexBound: number, priorLodScale: number) {
    const lodMask = ~0 << lod >>> 0;
    const size = 1 << lod;
    const gridX = chunkCoordinates[chunkIndex * 3] & lodMask,
          gridY = chunkCoordinates[chunkIndex * 3 + 1] & lodMask,
          gridZ = chunkCoordinates[chunkIndex * 3 + 2] & lodMask;
    let chunkEndIndex: number;
    if (lod == maxLod) {
      chunkEndIndex = chunkEndIndexBound;
    } else if (lod == 0) {
      chunkEndIndex = chunkIndex + 1;
    } else {
      chunkEndIndex = getChunkEndIndex(
          gridX, gridY, gridZ, lod, chunkIndex, chunkEndIndexBound, chunkCoordinates);
    }
    let xLower = gridX * chunkShape[0] + chunkGridSpatialOrigin[0],
        yLower = gridY * chunkShape[1] + chunkGridSpatialOrigin[1],
        zLower = gridZ * chunkShape[2] + chunkGridSpatialOrigin[2];
    let xUpper = xLower + size * chunkShape[0], yUpper = yLower + size * chunkShape[1],
        zUpper = zLower + size * chunkShape[2];
    xLower = Math.max(xLower, objectXLower);
    yLower = Math.max(yLower, objectYLower);
    zLower = Math.max(zLower, objectZLower);
    xUpper = Math.min(xUpper, objectXUpper);
    yUpper = Math.min(yUpper, objectYUpper);
    zUpper = Math.min(zUpper, objectZUpper);

    if (isAABBVisible(xLower, yLower, zLower, xUpper, yUpper, zUpper, clippingPlanes)) {
      const minW = Math.max(minWClip, getBoxW(xLower, yLower, zLower, xUpper, yUpper, zUpper));
      const pixelSize = minW / scaleFactor;

      if (priorLodScale === 0 || pixelSize * detailCutoff < priorLodScale) {
        const lodScale = lodScales[lod];
        if (lodScale !== 0) {
          callback(lod, chunkIndex, chunkEndIndex, lodScale / pixelSize);
        }

        if (lod > 0 && (lodScale === 0 || pixelSize * detailCutoff < lodScale)) {
          const nextPriorLodScale = lodScale === 0 ? priorLodScale : lodScale;
          do {
            chunkIndex = handleChunk(lod - 1, chunkIndex, chunkEndIndex, nextPriorLodScale);
          } while (chunkIndex < chunkEndIndex);
        }
      }
    }
    return chunkEndIndex;
  }

  const numChunks = chunkCoordinates.length / 3;
  handleChunk(maxLod, 0, numChunks, 0);
}

export function getMultiscaleChunksToDraw(
    manifest: MultiscaleMeshManifest, modelViewProjection: mat4, clippingPlanes: Float32Array,
    detailCutoff: number, viewportWidth: number, viewportHeight: number,
    hasChunk: (lod: number, chunkIndex: number, renderScale: number) => boolean,
    callback: (
        lod: number, chunkIndex: number, subChunkBegin: number, subChunkEnd: number,
        renderScale: number) => void) {
  const maxLod = manifest.lodScales.length - 1;

  const stackEntryStride = 3;

  const stack: number[] = [];
  let stackDepth = 0;

  let priorChunkIndex = 0;

  function emitChunksUpTo(chunkIndex: number) {
    while (priorChunkIndex < chunkIndex && stackDepth > 0) {
      const stackIndex = stackDepth - 1;
      const entryStartIndex = stack[stackEntryStride * stackIndex];
      const entryEndIndex = stack[stackEntryStride * stackIndex + 1];
      const curBegin = Math.max(entryStartIndex, priorChunkIndex);
      const curEnd = Math.min(entryEndIndex, chunkIndex);
      if (curBegin < curEnd) {
        callback(
            maxLod - stackIndex, entryStartIndex, curBegin - entryStartIndex,
            curEnd - entryStartIndex, stack[stackEntryStride * stackIndex + 2]);
      }
      if (curEnd == entryEndIndex) {
        --stackDepth;
      }
      priorChunkIndex = curEnd;
    }
    priorChunkIndex = chunkIndex;
  }

  getDesiredMultiscaleMeshChunks(
      manifest, modelViewProjection, clippingPlanes, detailCutoff, viewportWidth, viewportHeight,
      (lod, chunkBeginIndex, chunkEndIndex, renderScale) => {
        if (!hasChunk(lod, chunkBeginIndex, renderScale)) {
          return;
        }
        emitChunksUpTo(chunkBeginIndex);
        const stackIndex = maxLod - lod;
        stack[stackIndex * stackEntryStride] = chunkBeginIndex;
        stack[stackIndex * stackEntryStride + 1] = chunkEndIndex;
        stack[stackIndex * stackEntryStride + 2] = renderScale;
        stackDepth = stackIndex + 1;
      });

  emitChunksUpTo(manifest.chunkCoordinates.length / 3);
}

export function getMultiscaleFragmentKey(objectKey: string, lod: number, chunkIndex: number) {
  return `${objectKey}/${lod}:${chunkIndex}`;
}

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

import type { mat4, vec3 } from "#src/util/geom.js";
import { isAABBVisible } from "#src/util/geom.js";
import { getOctreeChildIndex } from "#src/util/zorder.js";

const DEBUG_CHUNKS_TO_DRAW = false;

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
   * The non-zero values must be non-decreasing.
   *
   * For each chunk, the chosen `lod` is the largest value such that
   * `lodScales[lod] <= detailCutoff * pixelSize`, where `pixelSize` is the maximum spatial distance
   * spanned by a single viewport pixel within the projected image of the chunk.
   */
  lodScales: Float32Array;

  /**
   * C order `[numLods, 3]` array specifying the xyz vertex position offset in object coordinates
   * for each level of detail.
   */
  vertexOffsets: Float32Array;

  /**
   * Row-major `[n, 5]` array where each row is of the form `[x, y, z, start, end_and_empty]`, where
   * `x`, `y`, and `z` are the chunk grid coordinates of the entry at a particular level of detail.
   * Row `n-1` corresponds to level of detail `lodScales.length - 1`, the root of the octree.  Given
   * a row corresponding to an octree node at level of detail `lod`, bits `start` specifies the row
   * number of the first child octree node at level of detail `lod-1`, and bits `[0,30]` of
   * `end_and_empty` specify one past the row number of the last child octree node.  Bit `31` of
   * `end_and_empty` is set to `1` if the mesh for the octree node is empty and should not be
   * requested/rendered.
   */
  octree: Uint32Array;
}

/**
 * @param detailCutoff Factor by which the spatial resolution of the mesh may be worse than the
 *     spatial resolution of a single viewport pixel.  For example, a value of 10 means that if a
 *     given portion of the object will be rendered such that a pixel corresponds to 50 nm, then a
 *     mesh level of detail down to 500 nm will be requested for that portion of the object.
 */
export function getDesiredMultiscaleMeshChunks(
  manifest: MultiscaleMeshManifest,
  modelViewProjection: mat4,
  clippingPlanes: Float32Array,
  detailCutoff: number,
  viewportWidth: number,
  viewportHeight: number,
  callback: (
    lod: number,
    row: number,
    renderScale: number,
    empty: number,
  ) => void,
) {
  const { octree, lodScales, chunkGridSpatialOrigin, chunkShape } = manifest;
  const maxLod = lodScales.length - 1;
  const m00 = modelViewProjection[0];
  const m01 = modelViewProjection[4];
  const m02 = modelViewProjection[8];
  const m10 = modelViewProjection[1];
  const m11 = modelViewProjection[5];
  const m12 = modelViewProjection[9];
  const m30 = modelViewProjection[3];
  const m31 = modelViewProjection[7];
  const m32 = modelViewProjection[11];
  const m33 = modelViewProjection[15];

  const minWXcoeff = m30 > 0 ? 0 : 1;
  const minWYcoeff = m31 > 0 ? 0 : 1;
  const minWZcoeff = m32 > 0 ? 0 : 1;

  const nearA = clippingPlanes[4 * 4];
  const nearB = clippingPlanes[4 * 4 + 1];
  const nearC = clippingPlanes[4 * 4 + 2];
  const nearD = clippingPlanes[4 * 4 + 3];

  function getPointW(x: number, y: number, z: number) {
    return m30 * x + m31 * y + m32 * z + m33;
  }

  function getBoxW(
    xLower: number,
    yLower: number,
    zLower: number,
    xUpper: number,
    yUpper: number,
    zUpper: number,
  ) {
    return getPointW(
      xLower + minWXcoeff * (xUpper - xLower),
      yLower + minWYcoeff * (yUpper - yLower),
      zLower + minWZcoeff * (zUpper - zLower),
    );
  }

  /**
   * Minimum value of w within clipping frustrum (under the assumption that the minimum value occurs
   * on the near clipping plane).
   */
  const minWClip = getPointW(-nearD * nearA, -nearD * nearB, -nearD * nearC);

  const objectXLower = manifest.clipLowerBound[0];
  const objectYLower = manifest.clipLowerBound[1];
  const objectZLower = manifest.clipLowerBound[2];
  const objectXUpper = manifest.clipUpperBound[0];
  const objectYUpper = manifest.clipUpperBound[1];
  const objectZUpper = manifest.clipUpperBound[2];

  const xScale = Math.sqrt(
    (m00 * viewportWidth) ** 2 + (m10 * viewportHeight) ** 2,
  );
  const yScale = Math.sqrt(
    (m01 * viewportWidth) ** 2 + (m11 * viewportHeight) ** 2,
  );
  const zScale = Math.sqrt(
    (m02 * viewportWidth) ** 2 + (m12 * viewportHeight) ** 2,
  );

  const scaleFactor = Math.max(xScale, yScale, zScale);

  function handleChunk(lod: number, row: number, priorLodScale: number) {
    const size = 1 << lod;
    const rowOffset = row * 5;
    const gridX = octree[rowOffset];
    const gridY = octree[rowOffset + 1];
    const gridZ = octree[rowOffset + 2];
    const childBeginAndVirtual = octree[rowOffset + 3];
    const childEndAndEmpty = octree[rowOffset + 4];
    let xLower = gridX * size * chunkShape[0] + chunkGridSpatialOrigin[0];
    let yLower = gridY * size * chunkShape[1] + chunkGridSpatialOrigin[1];
    let zLower = gridZ * size * chunkShape[2] + chunkGridSpatialOrigin[2];
    let xUpper = xLower + size * chunkShape[0];
    let yUpper = yLower + size * chunkShape[1];
    let zUpper = zLower + size * chunkShape[2];
    xLower = Math.max(xLower, objectXLower);
    yLower = Math.max(yLower, objectYLower);
    zLower = Math.max(zLower, objectZLower);
    xUpper = Math.min(xUpper, objectXUpper);
    yUpper = Math.min(yUpper, objectYUpper);
    zUpper = Math.min(zUpper, objectZUpper);

    if (
      isAABBVisible(
        xLower,
        yLower,
        zLower,
        xUpper,
        yUpper,
        zUpper,
        clippingPlanes,
      )
    ) {
      const minW = Math.max(
        minWClip,
        getBoxW(xLower, yLower, zLower, xUpper, yUpper, zUpper),
      );
      const pixelSize = minW / scaleFactor;

      if (priorLodScale === 0 || pixelSize * detailCutoff < priorLodScale) {
        let lodScale = lodScales[lod];
        if (lodScale !== 0) {
          const virtual = childBeginAndVirtual >>> 31;
          if (virtual) {
            lodScale = 0;
          }
          const empty = childEndAndEmpty >>> 31;
          callback(lod, row, lodScale / pixelSize, empty | virtual);
        }

        if (lod > 0 && (lodScale === 0 || pixelSize * detailCutoff < lodScale)) {
          const nextPriorLodScale = lodScale === 0 ? priorLodScale : lodScale;
          const childBegin = (childBeginAndVirtual & 0x7fffffff) >>> 0;
          const childEnd = (childEndAndEmpty & 0x7fffffff) >>> 0;
          for (let childRow = childBegin; childRow < childEnd; ++childRow) {
            handleChunk(lod - 1, childRow, nextPriorLodScale);
          }
        }
      }
    }
  }
  handleChunk(maxLod, octree.length / 5 - 1, 0);
}

export function getMultiscaleChunksToDraw(
  manifest: MultiscaleMeshManifest,
  modelViewProjection: mat4,
  clippingPlanes: Float32Array,
  detailCutoff: number,
  viewportWidth: number,
  viewportHeight: number,
  hasChunk: (lod: number, row: number, renderScale: number) => boolean,
  callback: (
    lod: number,
    row: number,
    subChunkBegin: number,
    subChunkEnd: number,
    renderScale: number,
  ) => void,
) {
  const { lodScales } = manifest;
  let maxLod = 0;
  while (maxLod + 1 < lodScales.length && lodScales[maxLod + 1] !== 0) {
    ++maxLod;
  }

  const stackEntryStride = 3;

  // [row, parentSubChunkIndex, renderScale]
  const stack: number[] = [];
  let stackDepth = 0;
  let priorSubChunkIndex = 0;
  function emitChunksUpTo(targetStackIndex: number, subChunkIndex: number) {
    if (DEBUG_CHUNKS_TO_DRAW) {
      console.log(
        `emitChunksUpTo: stackDepth=${stackDepth}, targetStackIndex=${targetStackIndex}, subChunkIndex=${subChunkIndex}, priorSubChunkIndex=${priorSubChunkIndex}`,
      );
    }
    while (true) {
      if (stackDepth === 0) return;

      // Finish last chunk of last (finest) lod.
      const stackIndex = stackDepth - 1;
      const entryLod = maxLod - stackIndex;
      const entryRow = stack[stackIndex * stackEntryStride];
      const numSubChunks = entryLod === 0 ? 1 : 8;
      const entrySubChunkIndex = stack[stackIndex * stackEntryStride + 1];
      const entryRenderScale = stack[stackIndex * stackEntryStride + 2];
      if (targetStackIndex === stackDepth) {
        const endSubChunk = subChunkIndex & (numSubChunks - 1);

        if (priorSubChunkIndex !== endSubChunk && entryRow !== -1) {
          if (DEBUG_CHUNKS_TO_DRAW) {
            console.log(
              `  drawing chunk because priorSubChunkIndex (${priorSubChunkIndex}) != endSubChunk (${endSubChunk})`,
            );
          }
          callback(
            entryLod,
            entryRow,
            priorSubChunkIndex,
            endSubChunk,
            entryRenderScale,
          );
        }
        priorSubChunkIndex = endSubChunk + 1;
        return;
      }
      if (priorSubChunkIndex !== numSubChunks && entryRow !== -1) {
        callback(
          entryLod,
          entryRow,
          priorSubChunkIndex,
          numSubChunks,
          entryRenderScale,
        );
      }
      priorSubChunkIndex = entrySubChunkIndex + 1;
      --stackDepth;
    }
  }

  let priorMissingLod = 0;
  if (DEBUG_CHUNKS_TO_DRAW) {
    console.log("");
    console.log("Starting to draw");
  }
  const { octree } = manifest;
  getDesiredMultiscaleMeshChunks(
    manifest,
    modelViewProjection,
    clippingPlanes,
    detailCutoff,
    viewportWidth,
    viewportHeight,
    (lod, row, renderScale, empty) => {
      if (!empty && !hasChunk(lod, row, renderScale)) {
        priorMissingLod = Math.max(lod, priorMissingLod);
        return;
      }
      if (lod < priorMissingLod) {
        // A parent chunk (containing chunk at coarser level-of-detail) is missing.  We can't draw
        // chunks at this level-of-detail because we would not be able to fill in gaps.
        return;
      }
      priorMissingLod = 0;
      const rowOffset = row * 5;
      const x = octree[rowOffset];
      const y = octree[rowOffset + 1];
      const z = octree[rowOffset + 2];
      const subChunkIndex = getOctreeChildIndex(x, y, z);
      const stackIndex = maxLod - lod;
      emitChunksUpTo(stackIndex, subChunkIndex);
      const stackOffset = stackIndex * stackEntryStride;
      stack[stackOffset] = empty ? -1 : row;
      stack[stackOffset + 1] = subChunkIndex;
      stack[stackOffset + 2] = renderScale;
      if (DEBUG_CHUNKS_TO_DRAW) {
        console.log(
          `Adding to stack: lod=${lod}, row=${stack[stackOffset]}, subChunkIndex=${subChunkIndex}`,
        );
      }
      priorSubChunkIndex = 0;
      stackDepth = stackIndex + 1;
    },
  );

  emitChunksUpTo(0, 0);
}

export function validateOctree(octree: Uint32Array, allowDuplicateChildren: boolean = false) {
  if (octree.length % 5 !== 0) {
    throw new Error("Invalid length");
  }
  const numNodes = octree.length / 5;
  const seenNodes = new Set<number>();
  function exploreNode(node: number) {
    if (seenNodes.has(node)) {
      throw new Error(`Previously seen node: ${node}`);
    }
    seenNodes.add(node);
    if (node < 0 || node >= numNodes) {
      throw new Error(`Invalid node reference: ${node}`);
    }
    const x = octree[node * 5];
    const y = octree[node * 5 + 1];
    const z = octree[node * 5 + 2];
    const beginChild = (octree[node * 5 + 3] & 0x7fffffff) >>> 0;
    const endChild = (octree[node * 5 + 4] & 0x7fffffff) >>> 0;
    if (
      beginChild < 0 ||
      endChild < 0 ||
      endChild < beginChild ||
      endChild > numNodes ||
      (!allowDuplicateChildren && beginChild + 8 < endChild)
    ) {
      throw new Error(
        `Invalid child references: node ${node} specifies beginChild=${beginChild}, endChild=${endChild}`,
      );
    }
    for (let child = beginChild; child < endChild; ++child) {
      const childX = octree[child * 5];
      const childY = octree[child * 5 + 1];
      const childZ = octree[child * 5 + 2];
      if (childX >>> 1 !== x || childY >>> 1 !== y || childZ >>> 1 !== z) {
        throw new Error(
          `invalid child position: parent=${node} child=${child} childX=${childX} childY=${childY} childZ=${childZ} parentX=${x} parentY=${y} parentZ=${z}`,
        );
      }
      exploreNode(child);
    }
  }
  if (numNodes === 0) return;
  exploreNode(numNodes - 1);
  if (seenNodes.size !== numNodes) {
    throw new Error("Orphan nodes in octree");
  }
}

export function getMultiscaleFragmentKey(
  objectKey: string,
  lod: number,
  chunkIndex: number,
) {
  return `${objectKey}/${lod}:${chunkIndex}`;
}

/**
 * @license
 * Copyright 2026 Google Inc.
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

import { describe, expect, it, vi } from "vitest";

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  OffscreenTextures,
  perspectivePanelEmit,
} from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { SegmentColorHash } from "#src/segment_color.js";
import {
  DEFAULT_FRAGMENT_MAIN,
  RenderHelper,
  type SegmentAppearanceParameters,
  type SkeletonChunkBase,
  type SkeletonGPUGeometry,
  SkeletonLayer,
  SkeletonRenderingOptions,
  SkeletonRenderMode,
  type SkeletonShaderContext,
  SkeletonSource,
  TrackableSkeletonLineWidth,
  TrackableSkeletonRenderMode,
  uploadSkeletonChunkToGPU,
  vertexPositionAttribute,
} from "#src/skeleton/frontend.js";
import { uploadSegmentIdTexture } from "#src/skeleton/spatial/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Map } from "#src/uint64_map.js";
import { Uint64Set } from "#src/uint64_set.js";
import { DataType } from "#src/util/data_type.js";
import { mat4, vec4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import {
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import {
  getFallbackBuilderState,
  parseShaderUiControls,
} from "#src/webgl/shader_ui_controls.js";
import { webglTest } from "#src/webgl/testing.js";
import {
  computeTextureFormat,
  TextureFormat,
} from "#src/webgl/texture_access.js";

function makePackedSkeletonChunk(
  positions: readonly (readonly number[])[],
  edges: readonly (readonly [number, number])[],
) {
  return {
    numVertices: positions.length,
    vertexAttributes: new Uint8Array(new Float32Array(positions.flat()).buffer),
    vertexAttributeOffsets: new Uint32Array([0]),
    indices: new Uint32Array(edges.flat()),
  };
}

function makeSkeletonLayer() {
  const source = Object.assign(Object.create(SkeletonSource.prototype), {
    chunks: new Map(),
    chunksChanged: new NullarySignal(),
  });
  const layer = Object.assign(Object.create(SkeletonLayer.prototype), {
    source,
    chunkNodes: new WeakMap(),
  });
  return { source, layer };
}

describe("precomputed skeleton layer", () => {
  it("tells listeners when a segment's skeleton enters or leaves memory", () => {
    const { source, layer } = makeSkeletonLayer();
    const listener = vi.fn();
    layer.nodesChanged.add(listener);
    const chunk = {
      ...makePackedSkeletonChunk(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        [[0, 1]],
      ),
      state: ChunkState.SYSTEM_MEMORY,
    };

    source.addChunk("5", chunk);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(layer.getSegmentNodes(5n)).toHaveLength(2);

    source.deleteChunk("5");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(layer.getSegmentNodes(5n)).toBeUndefined();
  });
});

const CANVAS_SIZE = 16;

function makeFramebuffer(gl: GL) {
  const framebuffer = new FramebufferConfiguration(gl, {
    colorBuffers: makeTextureBuffers(
      gl,
      OffscreenTextures.NUM_TEXTURES,
      WebGL2RenderingContext.RGBA32F,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.FLOAT,
    ),
  });
  framebuffer.bind(CANVAS_SIZE, CANVAS_SIZE);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
  return framebuffer;
}

// Clip coordinates in [-1, 1] map to the pixel under them.
function readPixel(
  framebuffer: FramebufferConfiguration,
  texture: OffscreenTextures,
  clipX: number,
  clipY: number,
) {
  const { gl } = framebuffer;
  const pixel = new Float32Array(4);
  framebuffer.bindSingle(texture);
  gl.readPixels(
    Math.floor(((clipX + 1) / 2) * CANVAS_SIZE),
    Math.floor(((clipY + 1) / 2) * CANVAS_SIZE),
    1,
    1,
    WebGL2RenderingContext.RGBA,
    WebGL2RenderingContext.FLOAT,
    pixel,
  );
  framebuffer.unbind();
  return pixel;
}

function makeRenderHelper(
  gl: GL,
  options: {
    segmentAppearance?: SegmentAppearanceParameters;
    spatialChunkCulling?: boolean;
    visibleSegmentIds?: bigint[];
    excludedSegmentIds?: bigint[];
    objectAlpha?: number;
  } = {},
) {
  const visibleSegments = new Uint64Set();
  visibleSegments.add(options.visibleSegmentIds ?? []);
  const excludedSegmentIds = new Uint64Set();
  excludedSegmentIds.add(options.excludedSegmentIds ?? []);
  const displayState = {
    segmentationGroupState: new WatchableValue({
      visibleSegments,
      temporaryVisibleSegments: new Uint64Set(),
      useTemporaryVisibleSegments: new WatchableValue(false),
    }),
    segmentationColorGroupState: new WatchableValue({
      segmentColorHash: new WatchableValue(SegmentColorHash.getDefault()),
      segmentStatedColors: new Uint64Map(),
      segmentDefaultColor: new WatchableValue(undefined),
    }),
    objectAlpha: new WatchableValue(options.objectAlpha ?? 1),
    hiddenObjectAlpha: new WatchableValue(0),
    saturation: new WatchableValue(1),
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: new WatchableValue(undefined),
  };
  const base = {
    vertexAttributes: [vertexPositionAttribute],
    gl,
    fallbackShaderParameters: new WatchableValue(
      getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
    ),
    displayState,
    skeletonShaderParameters: new WatchableValue({
      segmentAppearance: options.segmentAppearance,
      spatialChunkCulling: options.spatialChunkCulling ?? false,
    }),
    excludedSegmentIds,
  } as unknown as SkeletonShaderContext;
  return new RenderHelper(base, /*targetIsSliceView=*/ false);
}

function makeSegmentAppearance(): SegmentAppearanceParameters {
  return {
    hasSegmentStatedColors: false,
    hasSegmentDefaultColor: false,
    hasProvisionalSegmentColors: false,
    hoverHighlight: false,
  };
}

function makeRenderContext() {
  return {
    emitter: perspectivePanelEmit,
    projectionParameters: {
      viewProjectionMat: mat4.create(),
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
    },
  } as unknown as PerspectiveViewRenderContext;
}

function makeDrawOptions(mode: SkeletonRenderMode, lineWidth: number) {
  return {
    modelMatrix: mat4.create(),
    renderOptions: {
      mode: new TrackableSkeletonRenderMode(mode),
      lineWidth: new TrackableSkeletonLineWidth(lineWidth),
    },
  };
}

function makeGeometry(
  gl: GL,
  positions: readonly (readonly number[])[],
  edges: readonly (readonly [number, number])[],
  segmentIds?: readonly bigint[],
): SkeletonGPUGeometry {
  const chunk = {
    ...makePackedSkeletonChunk(positions, edges),
    numIndices: edges.length * 2,
    source: {
      attributeTextureFormats: [
        computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3),
      ],
    },
  } as unknown as SkeletonChunkBase;
  uploadSkeletonChunkToGPU(gl, chunk);
  if (segmentIds !== undefined) {
    chunk.segmentIdTexture = uploadSegmentIdTexture(
      gl,
      BigUint64Array.from(segmentIds),
    );
  }
  return chunk;
}

describe("skeleton render helper", () => {
  it("gives the edges and nodes of a skeleton its colour and pick ID", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl);
      const skeleton = makeGeometry(
        gl,
        [
          [-0.6, 0, 0],
          [0.6, 0, 0],
        ],
        [[0, 1]],
      );

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES_AND_POINTS, 2),
        (pass) => {
          pass.setColor(vec4.fromValues(0, 0, 1, 1));
          pass.setPickId(5);
          pass.draw(skeleton);
        },
      );

      expect([
        ...readPixel(framebuffer, OffscreenTextures.COLOR, 0, 0),
      ]).toEqual([0, 0, 1, 1]);
      expect(readPixel(framebuffer, OffscreenTextures.PICK, 0, 0)[0]).toBe(5);
      expect([
        ...readPixel(framebuffer, OffscreenTextures.COLOR, 0.6, 0),
      ]).toEqual([0, 0, 1, 1]);
      expect(readPixel(framebuffer, OffscreenTextures.PICK, 0.6, 0)[0]).toBe(5);
    });
  });

  it("draws each skeleton in the colour given for it", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl);
      const left = makeGeometry(gl, [[-0.5, 0, 0]], []);
      const right = makeGeometry(gl, [[0.5, 0, 0]], []);

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES_AND_POINTS, 2),
        (pass) => {
          pass.setColor(vec4.fromValues(1, 0, 0, 1));
          pass.draw(left);
          pass.setColor(vec4.fromValues(0, 1, 0, 1));
          pass.draw(right);
        },
      );

      expect([
        ...readPixel(framebuffer, OffscreenTextures.COLOR, -0.5, 0),
      ]).toEqual([1, 0, 0, 1]);
      expect([
        ...readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0),
      ]).toEqual([0, 1, 0, 1]);
    });
  });

  it("reports the picked node and edge of a chunk", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl, {
        segmentAppearance: makeSegmentAppearance(),
        visibleSegmentIds: [7n],
      });
      const chunk = makeGeometry(
        gl,
        [
          [-0.6, -0.5, 0],
          [0.6, -0.5, 0],
          [0, 0.5, 0],
        ],
        [[0, 1]],
        [7n, 7n, 7n],
      );

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES, 3),
        (pass) => {
          pass.setElementPickIds(10, 20);
          pass.draw(chunk);
        },
      );

      expect(readPixel(framebuffer, OffscreenTextures.PICK, 0, -0.5)[0]).toBe(
        10,
      );
      expect(readPixel(framebuffer, OffscreenTextures.PICK, 0.6, -0.5)[0]).toBe(
        21,
      );
      expect(readPixel(framebuffer, OffscreenTextures.PICK, 0, 0.5)[0]).toBe(
        22,
      );
    });
  });

  it("moves a dragged node only in the chunk that holds it", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl);
      const draggedChunk = makeGeometry(gl, [[-0.5, 0, 0]], []);
      const otherChunk = makeGeometry(gl, [[0.5, 0, 0]], []);

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES_AND_POINTS, 2),
        (pass) => {
          pass.setColor(vec4.fromValues(1, 1, 1, 1));
          pass.setNodePositionOverride({
            vertexIndex: 0,
            position: [-0.5, 0.5, 0],
          });
          pass.draw(draggedChunk);
          pass.setNodePositionOverride(undefined);
          pass.draw(otherChunk);
        },
      );

      expect(
        readPixel(framebuffer, OffscreenTextures.COLOR, -0.5, 0.5)[3],
      ).toBe(1);
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, -0.5, 0)[3]).toBe(
        0,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0)[3]).toBe(
        1,
      );
    });
  });

  it("hides the skeletons excluded from the pass", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl, {
        segmentAppearance: makeSegmentAppearance(),
        visibleSegmentIds: [1n, 2n],
        excludedSegmentIds: [2n],
      });
      const chunk = makeGeometry(
        gl,
        [
          [-0.5, 0, 0],
          [0.5, 0, 0],
        ],
        [],
        [1n, 2n],
      );

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES_AND_POINTS, 2),
        (pass) => pass.draw(chunk),
      );

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, -0.5, 0)[3]).toBe(
        1,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0)[3]).toBe(
        0,
      );
    });
  });

  it("draws an edge held by two chunks only once", () => {
    webglTest((gl) => {
      const framebuffer = makeFramebuffer(gl);
      const renderHelper = makeRenderHelper(gl, {
        segmentAppearance: makeSegmentAppearance(),
        spatialChunkCulling: true,
        visibleSegmentIds: [1n],
        objectAlpha: 0.5,
      });
      const edge = makeGeometry(
        gl,
        [
          [-0.8, 0, 0],
          [0.8, 0, 0],
        ],
        [[0, 1]],
        [1n, 1n],
      );
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.blendFunc(WebGL2RenderingContext.ONE, WebGL2RenderingContext.ONE);

      renderHelper.draw(
        makeRenderContext(),
        makeDrawOptions(SkeletonRenderMode.LINES, 4),
        (pass) => {
          pass.setChunkBounds(
            Float32Array.of(-1, -1, -1),
            Float32Array.of(0, 1, 1),
          );
          pass.draw(edge);
          pass.setChunkBounds(
            Float32Array.of(0, -1, -1),
            Float32Array.of(1, 1, 1),
          );
          pass.draw(edge);
        },
      );

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, -0.4, 0)[3]).toBe(
        0.5,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.4, 0)[3]).toBe(
        0.5,
      );
    });
  });
});

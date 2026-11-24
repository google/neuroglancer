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
import { DisplayContext } from "#src/display_context.js";
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { makeLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#layer/segmentation";
import {
  OffscreenTextures,
  perspectivePanelEmit,
} from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import {
  RenderHelper,
  type SkeletonChunkBase,
  SkeletonGeometryKind,
  type SkeletonGPUGeometry,
  SkeletonLayer,
  SkeletonRenderMode3d,
  SkeletonSegmentState,
  type SkeletonShaderContext,
  SkeletonSource,
  TrackableSkeletonLineWidth,
  TrackableSkeletonRenderMode3d,
  uploadSkeletonChunkToGPU,
  vertexPositionAttribute,
} from "#src/skeleton/frontend.js";
import { uploadSegmentIdTexture } from "#src/skeleton/spatial/frontend.js";
import { packColor } from "#src/util/color.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import { Viewer } from "#src/viewer.js";
import type { GL } from "#src/webgl/context.js";
import {
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";
import { setControlsInShader } from "#src/webgl/shader_ui_controls.js";
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

type SegmentationDisplayState = SegmentationUserLayer["displayState"];

function segmentationLayerTest(
  body: (
    displayState: SegmentationDisplayState,
    gl: GL,
    resources: RefCounted,
  ) => void,
) {
  const resources = new RefCounted();
  try {
    const display = resources.registerDisposer(
      new DisplayContext(document.createElement("div")),
    );
    const viewer = resources.registerDisposer(new Viewer(display));
    const managedLayer = resources.registerDisposer(
      makeLayer(viewer.layerSpecification, "test", { type: "segmentation" }),
    );
    const { displayState } = managedLayer.layer as SegmentationUserLayer;
    body(displayState, viewer.chunkManager.chunkQueueManager.gl, resources);
  } finally {
    resources.dispose();
  }
}

function makeRenderHelper(
  displayState: SegmentationDisplayState,
  gl: GL,
  resources: RefCounted,
  options: {
    geometryKind: SkeletonGeometryKind;
    mode?: SkeletonRenderMode3d;
    lineWidth?: number;
    targetIsSliceView?: boolean;
    segmentStates?: [bigint, SkeletonSegmentState][];
  },
) {
  const segmentStatesHashMap = new HashMapUint64();
  for (const [segmentId, state] of options.segmentStates ?? []) {
    segmentStatesHashMap.set(segmentId, BigInt(state));
  }
  const base = {
    vertexAttributes: [vertexPositionAttribute],
    gl,
    displayState,
    geometryKind: options.geometryKind,
    segmentStatesHashMap,
  } as unknown as SkeletonShaderContext;
  return resources.registerDisposer(
    new RenderHelper(base, options.targetIsSliceView ?? false, {
      mode: new TrackableSkeletonRenderMode3d(
        options.mode ?? SkeletonRenderMode3d.LINES,
      ),
      lineWidth: new TrackableSkeletonLineWidth(options.lineWidth ?? 1),
    }),
  );
}

function setSegmentColor(
  displayState: SegmentationDisplayState,
  segmentId: bigint,
  color: vec3,
) {
  displayState.segmentStatedColors.value.set(
    segmentId,
    BigInt(packColor(color)),
  );
}

function makeOffscreenFramebuffer(gl: GL, size: number) {
  const framebuffer = new FramebufferConfiguration(gl, {
    colorBuffers: makeTextureBuffers(
      gl,
      OffscreenTextures.NUM_TEXTURES,
      WebGL2RenderingContext.RGBA32F,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.FLOAT,
    ),
  });
  framebuffer.bind(size, size);
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
  const { gl, width, height } = framebuffer;
  const pixel = new Float32Array(4);
  framebuffer.bindSingle(texture);
  gl.readPixels(
    Math.floor(((clipX + 1) / 2) * width),
    Math.floor(((clipY + 1) / 2) * height),
    1,
    1,
    WebGL2RenderingContext.RGBA,
    WebGL2RenderingContext.FLOAT,
    pixel,
  );
  framebuffer.unbind();
  return pixel;
}

function makeRenderContext(
  emitter: PerspectiveViewRenderContext["emitter"],
  size: number,
) {
  return {
    emitter,
    projectionParameters: {
      viewProjectionMat: mat4.create(),
      invViewMatrix: mat4.create(),
      displayDimensionRenderInfo: {
        canonicalVoxelFactors: Float64Array.of(1, 1, 1),
      },
      width: size,
      height: size,
    },
    lightDirection: vec3.fromValues(0, 0, 1),
    ambientLighting: 0,
    directionalLighting: 1,
  } as unknown as PerspectiveViewRenderContext;
}

function makeDrawOptions(binding: RefCounted) {
  return { modelMatrix: mat4.create(), binding };
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
  it("gives the edges and nodes of a skeleton its segment colour and pick ID", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
      });
      setSegmentColor(displayState, 3n, vec3.fromValues(0, 0, 1));
      const skeleton = makeGeometry(
        gl,
        [
          [-0.6, 0, 0],
          [0.6, 0, 0],
        ],
        [[0, 1]],
      );

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(skeleton, { colorSegmentId: 3n, pickIds: 5 }),
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

  it("draws each skeleton in the colour of its own segment", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
      });
      setSegmentColor(displayState, 1n, vec3.fromValues(1, 0, 0));
      setSegmentColor(displayState, 2n, vec3.fromValues(0, 1, 0));
      const left = makeGeometry(gl, [[-0.5, 0, 0]], []);
      const right = makeGeometry(gl, [[0.5, 0, 0]], []);

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => {
          drawSkeleton(left, { colorSegmentId: 1n });
          drawSkeleton(right, { colorSegmentId: 2n });
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
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES,
        lineWidth: 3,
        geometryKind: SkeletonGeometryKind.SEGMENT_PER_VERTEX,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(7n);
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(chunk, {
            pickIds: { firstEdgePickId: 10, firstNodePickId: 20 },
          }),
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
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
      });
      const draggedChunk = makeGeometry(gl, [[-0.5, 0, 0]], []);
      const otherChunk = makeGeometry(gl, [[0.5, 0, 0]], []);

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => {
          drawSkeleton(draggedChunk, {
            colorSegmentId: 1n,
            nodePositionOverride: { vertexIndex: 0, position: [-0.5, 0.5, 0] },
          });
          drawSkeleton(otherChunk, { colorSegmentId: 1n });
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

  it("hides, in spatial index chunks, the skeletons that another pass draws whole", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SPATIAL_INDEX_CHUNK,
        segmentStates: [[2n, SkeletonSegmentState.EXCLUDED_FROM_CHUNKS]],
      });
      displayState.segmentationGroupState.value.visibleSegments.add([1n, 2n]);
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(chunk, {
            chunkBounds: {
              origin: Float32Array.of(-1, -1, -1),
              upperBound: Float32Array.of(1, 1, 1),
            },
          }),
      );

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, -0.5, 0)[3]).toBe(
        1,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0)[3]).toBe(
        0,
      );
    });
  });

  it("draws, outside spatial index chunks, a skeleton that the chunks hide", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SEGMENT_PER_VERTEX,
        segmentStates: [[2n, SkeletonSegmentState.EXCLUDED_FROM_CHUNKS]],
      });
      displayState.segmentationGroupState.value.visibleSegments.add(2n);
      const skeleton = makeGeometry(gl, [[0.5, 0, 0]], [], [2n]);

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => drawSkeleton(skeleton, {}),
      );

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0)[3]).toBe(
        1,
      );
    });
  });

  it("draws a provisional skeleton in red when spatial index chunks would hide it", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES_AND_POINTS,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SEGMENT_PER_VERTEX,
        segmentStates: [
          [
            3n,
            SkeletonSegmentState.PROVISIONAL |
              SkeletonSegmentState.EXCLUDED_FROM_CHUNKS,
          ],
        ],
      });
      displayState.segmentationGroupState.value.visibleSegments.add(3n);
      const skeleton = makeGeometry(gl, [[0.5, 0, 0]], [], [3n]);

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => drawSkeleton(skeleton, {}),
      );

      expect([
        ...readPixel(framebuffer, OffscreenTextures.COLOR, 0.5, 0),
      ]).toEqual([1, 0, 0, 1]);
    });
  });

  it("draws an edge held by two chunks only once", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.LINES,
        lineWidth: 4,
        geometryKind: SkeletonGeometryKind.SPATIAL_INDEX_CHUNK,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(1n);
      displayState.objectAlpha.value = 0.5;
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => {
          drawSkeleton(edge, {
            chunkBounds: {
              origin: Float32Array.of(-1, -1, -1),
              upperBound: Float32Array.of(0, 1, 1),
            },
          });
          drawSkeleton(edge, {
            chunkBounds: {
              origin: Float32Array.of(0, -1, -1),
              upperBound: Float32Array.of(1, 1, 1),
            },
          });
        },
      );
      gl.disable(WebGL2RenderingContext.BLEND);

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, -0.4, 0)[3]).toBe(
        0.5,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.4, 0)[3]).toBe(
        0.5,
      );
    });
  });

  it("reports the picked edge and node of a chunk drawn as cylinders and spheres", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.CYLINDERS_AND_SPHERES,
        lineWidth: 3,
        geometryKind: SkeletonGeometryKind.SEGMENT_PER_VERTEX,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(7n);
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(chunk, {
            pickIds: { firstEdgePickId: 10, firstNodePickId: 20 },
          }),
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

  it("draws edges and nodes as round surfaces that bulge towards the viewer", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.CYLINDERS_AND_SPHERES,
        lineWidth: 3,
        geometryKind: SkeletonGeometryKind.SEGMENT_PER_VERTEX,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(7n);
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => drawSkeleton(chunk, {}),
      );

      // A flat line would lie at depth 0.5, so z = 1 - depth would be 0.5.
      expect(
        readPixel(framebuffer, OffscreenTextures.Z, 0, -0.5)[0],
      ).toBeGreaterThan(0.5);
      expect(
        readPixel(framebuffer, OffscreenTextures.Z, 0, 0.5)[0],
      ).toBeGreaterThan(0.5);
    });
  });

  it("draws a cylinder held by two chunks only once", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.CYLINDERS,
        lineWidth: 4,
        geometryKind: SkeletonGeometryKind.SPATIAL_INDEX_CHUNK,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(1n);
      displayState.objectAlpha.value = 0.5;
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
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) => {
          drawSkeleton(edge, {
            chunkBounds: {
              origin: Float32Array.of(-1, -1, -1),
              upperBound: Float32Array.of(0, 1, 1),
            },
          });
          drawSkeleton(edge, {
            chunkBounds: {
              origin: Float32Array.of(0, -1, -1),
              upperBound: Float32Array.of(1, 1, 1),
            },
          });
        },
      );
      gl.disable(WebGL2RenderingContext.BLEND);

      for (const clipX of [-0.4, -0.0625, 0, 0.4]) {
        expect(
          readPixel(framebuffer, OffscreenTextures.COLOR, clipX, 0)[3],
        ).toBe(0.5);
      }
    });
  });

  it("draws a node on a chunk boundary as a whole sphere in its own chunk", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.CYLINDERS_AND_SPHERES,
        lineWidth: 4,
        geometryKind: SkeletonGeometryKind.SPATIAL_INDEX_CHUNK,
      });
      displayState.segmentationGroupState.value.visibleSegments.add(1n);
      // A diameter of 8 pixels reaches 0.5 either side of the centre.
      const node = makeGeometry(gl, [[0.1, 0, 0]], [], [1n]);

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(node, {
            chunkBounds: {
              origin: Float32Array.of(0, -1, -1),
              upperBound: Float32Array.of(1, 1, 1),
            },
          }),
      );

      for (const clipX of [-0.25, 0.1, 0.4]) {
        expect(
          readPixel(framebuffer, OffscreenTextures.COLOR, clipX, 0)[3],
        ).toBe(1);
      }
    });
  });

  it("moves a dragged node and the cylinders that meet it", () => {
    segmentationLayerTest((displayState, gl, resources) => {
      const framebuffer = makeOffscreenFramebuffer(gl, 16);
      const renderHelper = makeRenderHelper(displayState, gl, resources, {
        mode: SkeletonRenderMode3d.CYLINDERS_AND_SPHERES,
        lineWidth: 2,
        geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
      });
      const skeleton = makeGeometry(
        gl,
        [
          [-0.6, 0, 0],
          [0.6, 0, 0],
        ],
        [[0, 1]],
      );

      renderHelper.draw(
        makeRenderContext(perspectivePanelEmit, 16),
        makeDrawOptions(resources),
        (drawSkeleton) =>
          drawSkeleton(skeleton, {
            colorSegmentId: 1n,
            nodePositionOverride: { vertexIndex: 1, position: [0.6, 0.6, 0] },
          }),
      );

      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.6, 0.6)[3]).toBe(
        1,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0, 0.3)[3]).toBe(
        1,
      );
      expect(readPixel(framebuffer, OffscreenTextures.COLOR, 0.6, 0)[3]).toBe(
        0,
      );
    });
  });
});

function emitColor(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "outColor", 0);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  outColor = color;
}
`);
}

describe.each([true, false])(
  "skeleton control namespaces with targetIsSliceView=%s",
  (targetIsSliceView) => {
    it("keeps same-named segment and skeleton controls independent", () => {
      segmentationLayerTest((displayState, gl, resources) => {
        const renderHelper = makeRenderHelper(displayState, gl, resources, {
          geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
          targetIsSliceView,
        });
        displayState.fragmentSegmentColor.value = `
#uicontrol float gain slider(min=0, max=1, default=0.25)
#uicontrol float unused slider(min=0, max=1, default=0.5)
#uicontrol bool enabled checkbox(default=true)
#uicontrol int choice select(options={"First": 0, "Second": 1}, default=0)
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  if (false) { color *= unused; }
  return enabled ? vec3(gain + float(choice)) : color;
}`;
        const skeletonState =
          displayState.skeletonRenderingOptions.shaderControlState;
        displayState.skeletonRenderingOptions.shader.value = `
#uicontrol float gain slider(min=0, max=1, default=0.75)
#uicontrol float unused slider(min=0, max=1, default=0.5)
#uicontrol bool enabled checkbox(default=true)
#uicontrol int choice select(options={"First": 0, "Second": 1}, default=1)
void main() {
  emitRGB(enabled ? segmentColor().rgb * gain + vec3(unused + float(choice)) : vec3(0.0));
}`;
        const segmentState = displayState.segmentColorShaderControlState;
        for (const getShader of [
          renderHelper.edgeShaderGetter,
          renderHelper.nodeShaderGetter,
        ]) {
          segmentState.state.get("enabled")!.trackable.value = true;
          const result = getShader(emitColor);
          expect(result.fallback).toBe(false);
          expect(result.shader).not.toBeNull();
          const shader = result.shader!;
          shader.bind();
          for (const [segmentGain, skeletonGain] of [
            [0.25, 0.75],
            [0.5, 0.125],
          ]) {
            segmentState.state.get("gain")!.trackable.value = segmentGain;
            skeletonState.state.get("gain")!.trackable.value = skeletonGain;
            setControlsInShader(
              gl,
              shader,
              skeletonState,
              result.parameters.skeletonShaderBuilderState.parseResult,
            );
            displayState.segmentationColorUserShader.enable(
              gl,
              shader,
              result.parameters.segmentColorShaderBuilderState,
              { fallback: result.fallback, binding: resources },
              result.parameters.segmentColorParameters,
            );
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_shaderControl_gain")!,
              ),
            ).toBeCloseTo(skeletonGain);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_segmentColorShaderControl_gain")!,
              ),
            ).toBeCloseTo(segmentGain);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_shaderControl_choice")!,
              ),
            ).toBe(1);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_segmentColorShaderControl_choice")!,
              ),
            ).toBe(0);
          }
          skeletonState.activeControls.trackShader(
            {
              ...result,
              parameters: result.parameters.skeletonShaderBuilderState,
            },
            resources,
          );
          expect(skeletonState.activeControls.hint.value).toEqual(
            new Set(["gain", "unused", "enabled", "choice"]),
          );
          expect(segmentState.activeControls.hint.value).toEqual(
            new Set(["gain", "enabled", "choice"]),
          );
          segmentState.state.get("enabled")!.trackable.value = false;
          const disabledResult = getShader(emitColor);
          expect(disabledResult.fallback).toBe(false);
          const disabledShader = disabledResult.shader!;
          disabledShader.bind();
          displayState.segmentationColorUserShader.enable(
            gl,
            disabledShader,
            disabledResult.parameters.segmentColorShaderBuilderState,
            { fallback: disabledResult.fallback, binding: resources },
            disabledResult.parameters.segmentColorParameters,
          );
          skeletonState.activeControls.trackShader(
            {
              ...disabledResult,
              parameters: disabledResult.parameters.skeletonShaderBuilderState,
            },
            resources,
          );
          expect(segmentState.activeControls.hint.value).toEqual(
            new Set(["enabled"]),
          );
          expect(skeletonState.activeControls.hint.value).toEqual(
            new Set(["gain", "unused", "enabled", "choice"]),
          );
        }
      });
    });
  },
);

describe.each([true, false])(
  "skeleton edge alpha with targetIsSliceView=%s",
  (targetIsSliceView) => {
    it.each([false, true])(
      "inherits segment alpha only with emitDefault=%s",
      (useDefaultColor) => {
        segmentationLayerTest((displayState, gl, resources) => {
          const renderHelper = makeRenderHelper(displayState, gl, resources, {
            mode: SkeletonRenderMode3d.LINES,
            lineWidth: 3,
            geometryKind: SkeletonGeometryKind.SINGLE_SEGMENT,
            targetIsSliceView,
          });
          const framebuffer = resources.registerDisposer(
            new FramebufferConfiguration(gl, {
              colorBuffers: makeTextureBuffers(gl, 1),
            }),
          );
          const edge = makeGeometry(
            gl,
            [
              [-1, 0, 0],
              [1, 0, 0],
            ],
            [[0, 1]],
          );
          displayState.skeletonRenderingOptions.shader.value = useDefaultColor
            ? "void main() { emitDefault(); }"
            : "void main() { emitRGB(vec3(1.0, 0.5, 0.25)); }";

          for (const segmentAlpha of [0.25, 1]) {
            displayState.fragmentSegmentColor.value = `
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  return vec4(0.25, 0.5, 1.0, ${segmentAlpha.toFixed(2)});
}`;
            for (const layerAlpha of [1, 0.5]) {
              displayState.objectAlpha.value = layerAlpha;
              framebuffer.bind(9, 9);
              gl.clearColor(0, 0, 0, 0);
              gl.clear(gl.COLOR_BUFFER_BIT);

              renderHelper.draw(
                makeRenderContext(emitColor, 9),
                makeDrawOptions(resources),
                (drawSkeleton) => drawSkeleton(edge, { colorSegmentId: 1n }),
              );

              const pixel = new Uint8Array(4);
              gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              const alpha = layerAlpha * (useDefaultColor ? segmentAlpha : 1);
              expect(Math.abs(pixel[3] / 255 - alpha)).toBeLessThan(2 / 255);
              const color = useDefaultColor ? [0.25, 0.5, 1] : [1, 0.5, 0.25];
              const rgbScale = targetIsSliceView ? 1 : alpha;
              for (const [component, value] of color.entries()) {
                expect(
                  Math.abs(pixel[component] / 255 - value * rgbScale),
                ).toBeLessThan(2 / 255);
              }
            }
          }
        });
      },
    );
  },
);

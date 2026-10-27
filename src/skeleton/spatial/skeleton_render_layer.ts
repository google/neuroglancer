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

/**
 * @file Draws spatially indexed skeletons in 2D and 3D panels, first from
 * spatial index chunks and then from all nodes of the chosen skeletons. It also
 * looks up nodes as the edit session displays them.
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import type {
  LayerView,
  MouseSelectionState,
  PickState,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type {
  PerspectiveViewReadyRenderContext,
  PerspectiveViewRenderContext,
} from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransform,
} from "#src/render_coordinate_transform.js";
import { getChunkTransformParameters } from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import type {
  RenderLayer,
  ThreeDimensionalRenderLayerAttachmentState,
} from "#src/renderlayer.js";
import { update3dRenderLayerAttachment } from "#src/renderlayer.js";
import {
  getBaseObjectColor,
  registerRedrawWhenSegmentationDisplayState3DChanged,
} from "#src/segmentation_display_state/frontend.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import {
  SkeletonEdgeDirection,
  type EditableSkeletonSource,
  type SkeletonFragmentSource,
  type SkeletonNode,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  DEFAULT_FRAGMENT_MAIN,
  getSkeletonNodeDiameter,
  RenderHelper,
  type SkeletonDrawOptions,
  type SkeletonGPUGeometry,
  type SkeletonLayerDisplayState,
  type SkeletonShaderContext,
  type SkeletonShaderParameters,
  type VertexAttributeRenderInfo,
  type ViewSpecificSkeletonRenderingOptions,
} from "#src/skeleton/frontend.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import {
  forEachSpatialSkeletonSourceScale,
  forEachVisibleSpatialSkeletonChunk,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID,
  SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
} from "#src/skeleton/spatial/base.js";
import type {
  MultiscaleSpatiallyIndexedSkeletonSource,
  SkeletonPickGeometry,
  SpatiallyIndexedSkeletonChunk,
  SpatiallyIndexedSkeletonSource,
} from "#src/skeleton/spatial/frontend.js";
import {
  disposeSpatiallyIndexedSkeletonSourceRuntimeState,
  uploadSegmentIdTexture,
} from "#src/skeleton/spatial/frontend.js";
import type {
  SkeletonOverlaySegments,
  SpatiallyIndexedSkeletonOverlayGeometry,
} from "#src/skeleton/spatial/overlay_segments.js";
import { getPendingNodeOverride } from "#src/skeleton/spatial/overlay_segments.js";
import {
  resolveSpatiallyIndexedSkeletonNodePick,
  resolveSpatiallyIndexedSkeletonSegmentPick,
} from "#src/skeleton/spatial/picking.js";
import type { SkeletonNodeHighlightSelection } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import { SkeletonOverlayPrimitives } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import type { SkeletonPanelView } from "#src/skeleton/spatial/skeleton_panel_overlay.js";
import { SkeletonPanelOverlay } from "#src/skeleton/spatial/skeleton_panel_overlay.js";
import { type TransformedSource } from "#src/sliceview/base.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
} from "#src/sliceview/frontend.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
  makeCachedLazyDerivedWatchableValue,
  WatchableValue,
  registerNested,
} from "#src/trackable_value.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { gatherUpdate } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { mat4, vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  drawBoxEdges,
  glsl_getBoxEdgeVertexPosition,
} from "#src/webgl/bounding_box.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ParameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import { parameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import {
  getFallbackBuilderState,
  parseShaderUiControls,
} from "#src/webgl/shader_ui_controls.js";
import {
  computeTextureFormat,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

interface VisibleChunk {
  chunk: SpatiallyIndexedSkeletonChunk;
  chunkLayout: ChunkLayout;
}

const tempMat4 = mat4.create();

interface SpatiallyIndexedSkeletonPickData {
  // Only overlay node picks ("node") move the mouse position onto the node.
  readonly kind: "node" | "edge" | "segment-node" | "segment-edge";
  readonly geometry: SkeletonPickGeometry;
}

function setMouseStatePositionFromSkeletonNode(
  mouseState: MouseSelectionState,
  nodePosition: Float32Array,
  transform: RenderLayerTransform,
) {
  const { rank } = transform;
  const modelPosition = new Float32Array(rank);
  for (let i = 0; i < Math.min(nodePosition.length, rank); ++i) {
    const v = nodePosition[i];
    if (!Number.isFinite(v)) return;
    modelPosition[i] = v;
  }
  const layerPosition = new Float32Array(rank);
  matrix.transformPoint(
    layerPosition,
    transform.modelToRenderLayerTransform,
    rank + 1,
    modelPosition,
    rank,
  );
  gatherUpdate(
    mouseState.position,
    layerPosition,
    transform.globalToRenderLayerDimensions,
  );
}
const overlayPositionTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  3,
);

type SpatiallyIndexedSkeletonSourceEntry =
  SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>;

export interface SpatiallyIndexedSkeletonLayerOptions {
  readonly multiscaleSource: MultiscaleSpatiallyIndexedSkeletonSource;
  readonly displayState: SpatiallyIndexedSkeletonLayerDisplayState & {
    readonly localPosition: WatchableValueInterface<Float32Array>;
  };
  readonly editSession: SpatialSkeletonEditSession;
  readonly nodeSelection: SkeletonNodeHighlightSelection;
  readonly overlaySegments: SkeletonOverlaySegments;
}

class SkeletonOverlayChunk
  implements SkeletonGPUGeometry, SkeletonPickGeometry
{
  readonly vertexAttributeTextures: (WebGLTexture | null)[];
  readonly segmentIdTexture: WebGLTexture;
  readonly indexBuffer: GLBuffer;
  readonly numIndices: number;
  readonly numVertices: number;
  readonly indices: Uint32Array;
  readonly nodeIds: BigUint64Array;
  readonly nodePositions: Float32Array;
  readonly segmentIds: BigUint64Array;
  // A drag moves one vertex through a uniform, so the chunk is not rebuilt.
  readonly nodeIndex: ReadonlyMap<bigint, number>;

  constructor(
    gl: GL,
    geometry: SpatiallyIndexedSkeletonOverlayGeometry,
    positionTextureFormat: TextureFormat,
  ) {
    const positionTexture = gl.createTexture();
    let segmentIdTexture: WebGLTexture | undefined;
    try {
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, positionTexture);
      setOneDimensionalTextureData(
        gl,
        positionTextureFormat,
        new Uint8Array(
          geometry.positions.buffer,
          geometry.positions.byteOffset,
          geometry.positions.byteLength,
        ),
      );
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
      segmentIdTexture = uploadSegmentIdTexture(gl, geometry.segmentIds);
      this.indexBuffer = GLBuffer.fromData(
        gl,
        geometry.indices,
        WebGL2RenderingContext.ARRAY_BUFFER,
        WebGL2RenderingContext.STATIC_DRAW,
      );
    } catch (error) {
      gl.deleteTexture(positionTexture);
      if (segmentIdTexture !== undefined) gl.deleteTexture(segmentIdTexture);
      throw error;
    }
    this.vertexAttributeTextures = [positionTexture];
    this.segmentIdTexture = segmentIdTexture;
    this.indices = geometry.indices;
    this.numIndices = geometry.indices.length;
    this.numVertices = geometry.numVertices;
    this.nodeIds = geometry.nodeIds;
    this.nodePositions = geometry.positions;
    this.segmentIds = geometry.segmentIds;
    this.nodeIndex = geometry.nodeIndex;
  }

  dispose(gl: GL) {
    for (const texture of this.vertexAttributeTextures) {
      if (texture) gl.deleteTexture(texture);
    }
    gl.deleteTexture(this.segmentIdTexture);
    this.indexBuffer.dispose();
  }
}

// Counts a chunk once per histogram per frame, even when several panels show it.
const seenChunkKeysPerFrame = new WeakMap<
  RenderScaleHistogram,
  {
    frameNumber: number;
    keys: Set<string>;
    indicatorSources: Set<SpatiallyIndexedSkeletonSource>;
  }
>();

const SPATIAL_SKELETON_RESOLUTION_INDICATOR_BAR_HEIGHT = 10;

export interface SpatiallyIndexedSkeletonLayerDisplayState
  extends SkeletonLayerDisplayState {
  spatialSkeletonSpacingTarget2d: WatchableValueInterface<number>;
  spatialSkeletonSpacingTarget3d: WatchableValueInterface<number>;
  spatialSkeletonSpacingHistogram2d: RenderScaleHistogram;
  spatialSkeletonSpacingHistogram3d: RenderScaleHistogram;
}

export class SpatiallyIndexedSkeletonLayer
  extends RefCounted
  implements SkeletonShaderContext, SkeletonNodeAccess
{
  redrawNeeded = new NullarySignal();
  vertexAttributes: VertexAttributeRenderInfo[];
  readonly browsePassLayerView: SkeletonShaderContext;
  readonly skeletonShaderParameters: WatchableValue<SkeletonShaderParameters>;
  readonly browsePassSkeletonShaderParameters: WatchableValueInterface<SkeletonShaderParameters>;
  fallbackShaderParameters = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );
  localPosition: WatchableValueInterface<Float32Array>;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;
  readonly chunkManager: ChunkManager;
  readonly displayState: SpatiallyIndexedSkeletonLayerOptions["displayState"];
  readonly editSession: SpatialSkeletonEditSession;
  readonly provisionalSegmentIds: Uint64Set;
  readonly multiscaleSource: MultiscaleSpatiallyIndexedSkeletonSource;
  private readonly sources: SpatiallyIndexedSkeletonSourceEntry[];
  readonly source: SpatiallyIndexedSkeletonSource;
  readonly fragmentSource: SkeletonFragmentSource;
  readonly editableSource: EditableSkeletonSource | undefined;
  readonly overlaySegments: SkeletonOverlaySegments;
  private readonly overlayChunks = new Map<
    bigint,
    {
      readonly geometry: SpatiallyIndexedSkeletonOverlayGeometry;
      readonly chunk: SkeletonOverlayChunk;
    }
  >();
  readonly overlayPrimitives: SkeletonOverlayPrimitives;

  getUniqueChunkSources() {
    const sources = new Set<SpatiallyIndexedSkeletonSource>();
    for (const sourceEntry of this.sources) {
      sources.add(sourceEntry.chunkSource);
    }
    return sources;
  }

  private readonly failedOverlayGeometries =
    new WeakSet<SpatiallyIndexedSkeletonOverlayGeometry>();

  private getOverlayChunks(): SkeletonOverlayChunk[] {
    const geometries = this.overlaySegments.updateGeometries(
      this,
      this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber,
    );
    for (const [segmentId, { chunk }] of this.overlayChunks) {
      if (geometries.has(segmentId)) continue;
      this.overlayChunks.delete(segmentId);
      chunk.dispose(this.gl);
    }
    const chunks: SkeletonOverlayChunk[] = [];
    for (const [segmentId, geometry] of geometries) {
      const previous = this.overlayChunks.get(segmentId);
      if (
        previous?.geometry !== geometry &&
        !this.failedOverlayGeometries.has(geometry)
      ) {
        try {
          const chunk = new SkeletonOverlayChunk(
            this.gl,
            geometry,
            overlayPositionTextureFormat,
          );
          this.overlayChunks.set(segmentId, { geometry, chunk });
          previous?.chunk.dispose(this.gl);
        } catch {
          // The last chunk stays drawn.
          this.failedOverlayGeometries.add(geometry);
        }
      }
      const entry = this.overlayChunks.get(segmentId);
      if (entry !== undefined) chunks.push(entry.chunk);
    }
    return chunks;
  }

  constructor(options: SpatiallyIndexedSkeletonLayerOptions) {
    super();
    const {
      multiscaleSource,
      displayState,
      editSession,
      nodeSelection,
      overlaySegments,
    } = options;
    this.multiscaleSource = multiscaleSource;
    this.chunkManager = multiscaleSource.chunkManager;
    this.displayState = displayState;
    this.editSession = editSession;
    this.provisionalSegmentIds = editSession.provisionalSegmentIds;
    this.fragmentSource = multiscaleSource.fragmentSource;
    this.editableSource = multiscaleSource.editableSource;
    this.registerDisposer(() => {
      for (const { chunk } of this.overlayChunks.values()) {
        chunk.dispose(this.gl);
      }
      this.overlayChunks.clear();
      disposeSpatiallyIndexedSkeletonSourceRuntimeState(
        this.getUniqueChunkSources(),
      );
      for (const { chunkSource } of this.sources) {
        chunkSource.dispose();
      }
    });
    const sources = multiscaleSource.getSources()[0];
    if (sources.length === 0) {
      throw new Error(
        "SpatiallyIndexedSkeletonLayer requires at least one source.",
      );
    }
    this.sources = sources;
    this.source = sources[0].chunkSource;
    this.localPosition = displayState.localPosition;
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        displayState.transform,
      ),
    );
    this.overlaySegments = overlaySegments;
    this.overlayPrimitives = this.registerDisposer(
      new SkeletonOverlayPrimitives({
        displayState,
        nodeSelection,
        editSession,
        getBaseSegmentColor: (segmentId) =>
          getBaseObjectColor(displayState, segmentId) as vec3,
      }),
    );
    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.registerDisposer(
      displayState.hiddenObjectAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      editSession.pendingNodePositionVersion.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    displayState.shaderError.value = undefined;
    const { skeletonRenderingOptions: renderingOptions } = displayState;
    this.registerDisposer(
      renderingOptions.shader.changed.add(() => {
        displayState.shaderError.value = undefined;
        this.redrawNeeded.dispatch();
      }),
    );

    this.vertexAttributes = [...this.source.vertexAttributes];
    const getSkeletonShaderParameters = (): SkeletonShaderParameters => {
      const colorGroupState = displayState.segmentationColorGroupState.value;
      return {
        segmentAppearance: {
          hasSegmentStatedColors:
            colorGroupState.segmentStatedColors.size !== 0,
          hasSegmentDefaultColor:
            colorGroupState.segmentDefaultColor.value !== undefined,
          hasProvisionalSegmentColors:
            editSession.provisionalSegmentIds.size !== 0,
          hoverHighlight: displayState.hoverHighlight.value,
        },
        spatialChunkCulling: false,
      };
    };
    this.skeletonShaderParameters = new WatchableValue(
      getSkeletonShaderParameters(),
    );
    const updateSkeletonShaderParameters = () => {
      this.skeletonShaderParameters.value = getSkeletonShaderParameters();
    };
    this.registerDisposer(
      registerNested((context, colorGroupState) => {
        context.registerDisposer(
          colorGroupState.segmentStatedColors.changed.add(
            updateSkeletonShaderParameters,
          ),
        );
        context.registerDisposer(
          colorGroupState.segmentDefaultColor.changed.add(
            updateSkeletonShaderParameters,
          ),
        );
        updateSkeletonShaderParameters();
      }, displayState.segmentationColorGroupState),
    );
    this.registerDisposer(
      displayState.hoverHighlight.changed.add(updateSkeletonShaderParameters),
    );
    this.registerDisposer(
      editSession.spatialSkeletonDisplay.changed.add(() => {
        updateSkeletonShaderParameters();
        this.redrawNeeded.dispatch();
      }),
    );
    this.registerDisposer(
      overlaySegments.changed.add(this.redrawNeeded.dispatch),
    );
    this.browsePassSkeletonShaderParameters = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (params) => ({ ...params, spatialChunkCulling: true }),
        this.skeletonShaderParameters,
      ),
    );

    this.browsePassLayerView = {
      vertexAttributes: this.source.vertexAttributes,
      gl: this.gl,
      fallbackShaderParameters: this.fallbackShaderParameters,
      displayState,
      skeletonShaderParameters: this.browsePassSkeletonShaderParameters,
      provisionalSegmentIds: editSession.provisionalSegmentIds,
      excludedSegmentIds: overlaySegments.browseExcludedSegments,
    };
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  private forEachVisibleChunkSlot(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
    callback: (
      chunkKey: string,
      chunkSource: SpatiallyIndexedSkeletonSource,
      chunkLayout: ChunkLayout,
    ) => void,
  ) {
    for (const scales of transformedSources) {
      forEachVisibleSpatialSkeletonChunk(
        projectionParameters,
        this.localPosition.value,
        spacingTarget,
        scales,
        () => {},
        (tsource) => {
          callback(
            tsource.curPositionInChunks.join(),
            tsource.source as SpatiallyIndexedSkeletonSource,
            tsource.chunkLayout,
          );
        },
      );
    }
  }

  // Fills `out` and the resolution histogram in one pass over the visible chunks.
  updateVisibleChunksAndHistogram(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
    histogram: RenderScaleHistogram,
    frameNumber: number,
    out: VisibleChunk[],
  ): VisibleChunk[] {
    histogram.begin(frameNumber);
    let count = 0;
    if (transformedSources.length === 0) {
      out.length = 0;
      return out;
    }
    let seen = seenChunkKeysPerFrame.get(histogram);
    if (seen === undefined || seen.frameNumber !== frameNumber) {
      seen = { frameNumber, keys: new Set(), indicatorSources: new Set() };
      seenChunkKeysPerFrame.set(histogram, seen);
    }
    const { keys: seenKeys, indicatorSources } = seen;
    const localPosition = this.localPosition.value;
    for (const scales of transformedSources) {
      forEachSpatialSkeletonSourceScale(
        projectionParameters,
        spacingTarget,
        scales,
        (tsource, _, physicalSpacing, pixelSpacing, selected) => {
          if (selected) return;
          const source = tsource.source as SpatiallyIndexedSkeletonSource;
          if (indicatorSources.has(source)) return;
          indicatorSources.add(source);
          histogram.add(
            physicalSpacing,
            pixelSpacing,
            0,
            SPATIAL_SKELETON_RESOLUTION_INDICATOR_BAR_HEIGHT,
            true,
          );
        },
      );
      forEachVisibleSpatialSkeletonChunk(
        projectionParameters,
        localPosition,
        spacingTarget,
        scales,
        () => {},
        (tsource, _, physicalSpacing, pixelSpacing) => {
          const source = tsource.source as SpatiallyIndexedSkeletonSource;
          const chunkKey = tsource.curPositionInChunks.join();
          const chunk = source.chunks.get(chunkKey);
          const isGpuResident = chunk?.state === ChunkState.GPU_MEMORY;
          if (isGpuResident) {
            // Entries are reused, so a frame allocates only when it has more chunks than the last.
            const entry = out[count];
            if (entry === undefined) {
              out[count] = { chunk: chunk!, chunkLayout: tsource.chunkLayout };
            } else {
              entry.chunk = chunk!;
              entry.chunkLayout = tsource.chunkLayout;
            }
            ++count;
          }
          // The histogram counts a chunk once across panels.
          const seenKey = `${getObjectId(source)}:${chunkKey}`;
          if (!seenKeys.has(seenKey)) {
            seenKeys.add(seenKey);
            if (isGpuResident) {
              histogram.add(physicalSpacing, pixelSpacing, 1, 0);
            } else {
              histogram.add(physicalSpacing, pixelSpacing, 0, 1);
            }
          }
        },
      );
    }
    out.length = count;
    return out;
  }

  private areVisibleChunksReady(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
  ) {
    if (
      this.displayState.objectAlpha.value <= 0.0 &&
      this.displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return true;
    }
    if (transformedSources.length === 0) {
      return false;
    }
    let ready = true;
    this.forEachVisibleChunkSlot(
      transformedSources,
      projectionParameters,
      spacingTarget,
      (chunkKey, chunkSource, _) => {
        const chunk = chunkSource.chunks.get(chunkKey);
        if (chunk?.state !== ChunkState.GPU_MEMORY) {
          ready = false;
        }
      },
    );
    return ready;
  }

  readonly hasPickableNodes = true;

  get nodesChanged() {
    return this.editSession.spatialSkeletonDisplay.changed;
  }

  getSegmentNodes(segmentId: bigint): readonly SkeletonNode[] | undefined {
    return this.editSession.getCachedSegmentNodes(segmentId);
  }

  get parentsInferred() {
    return (
      this.fragmentSource?.edgeDirection === SkeletonEdgeDirection.UNDIRECTED
    );
  }

  getNode(nodeId: bigint): SkeletonNode | undefined {
    if (nodeId === 0n) return undefined;
    return this.editSession.getDisplayedNode(nodeId);
  }

  private drawBrowsePass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    options: SkeletonDrawOptions,
    visibleChunks: VisibleChunk[],
  ) {
    if (visibleChunks.length === 0) return;
    this.overlaySegments.updateBrowseExcludedSegments();
    const chunkOrigin = vec3.create();
    const chunkBound = vec3.create();
    renderHelper.draw(renderContext, options, (pass) => {
      for (const { chunk, chunkLayout } of visibleChunks) {
        vec3.mul(chunkOrigin, chunk.chunkGridPosition, chunkLayout.size);
        vec3.add(chunkBound, chunkOrigin, chunkLayout.size);
        pass.setChunkBounds(chunkOrigin, chunkBound);
        if (renderContext.emitPickID) {
          const { firstEdgePickId, firstNodePickId } = registerSkeletonPickIds(
            renderContext,
            layer,
            chunk,
            {
              edgeKind: "segment-edge",
              nodeKind: "segment-node",
            },
          );
          pass.setElementPickIds(firstEdgePickId, firstNodePickId);
        }
        pass.draw(chunk);
      }
    });
  }

  private drawInspectionOverlayPass(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    renderHelper: RenderHelper,
    options: SkeletonDrawOptions,
  ) {
    const overlayChunks = this.getOverlayChunks();
    if (overlayChunks.length === 0) return;
    renderHelper.draw(renderContext, options, (pass) => {
      for (const overlayChunk of overlayChunks) {
        if (renderContext.emitPickID) {
          const { firstEdgePickId, firstNodePickId } = registerSkeletonPickIds(
            renderContext,
            layer,
            overlayChunk,
            { edgeKind: "edge", nodeKind: "node" },
          );
          pass.setElementPickIds(firstEdgePickId, firstNodePickId);
        }
        pass.setNodePositionOverride(
          getPendingNodeOverride(overlayChunk.nodeIndex, this.editSession),
        );
        pass.draw(overlayChunk);
      }
    });
  }

  draw(
    renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
    layer: RenderLayer,
    overlayRenderHelper: RenderHelper,
    browseRenderHelper: RenderHelper,
    renderOptions: ViewSpecificSkeletonRenderingOptions,
    modelMatrix: mat4,
    visibleChunks: VisibleChunk[],
  ) {
    const { displayState } = this;
    if (
      displayState.objectAlpha.value <= 0.0 &&
      displayState.hiddenObjectAlpha.value <= 0.0
    ) {
      return;
    }

    const options: SkeletonDrawOptions = { modelMatrix, renderOptions };
    this.drawBrowsePass(
      renderContext,
      layer,
      browseRenderHelper,
      options,
      visibleChunks,
    );
    this.drawInspectionOverlayPass(
      renderContext,
      layer,
      overlayRenderHelper,
      options,
    );
  }

  isReady(
    transformedSources: readonly TransformedSource[][],
    projectionParameters: ProjectionParameters,
    spacingTarget: number,
  ) {
    return this.areVisibleChunksReady(
      transformedSources,
      projectionParameters,
      spacingTarget,
    );
  }
}

function registerSkeletonPickIds(
  renderContext: SliceViewPanelRenderContext | PerspectiveViewRenderContext,
  layer: RenderLayer,
  geometry: SkeletonPickGeometry,
  kinds: {
    readonly edgeKind: SpatiallyIndexedSkeletonPickData["kind"];
    readonly nodeKind: SpatiallyIndexedSkeletonPickData["kind"];
  },
): { firstEdgePickId: number; firstNodePickId: number } {
  const { pickIDs } = renderContext;
  const numEdges = geometry.indices.length / 2;
  const { numVertices } = geometry;
  return {
    firstEdgePickId:
      numEdges === 0
        ? 0
        : pickIDs.register(layer, numEdges, 0n, {
            kind: kinds.edgeKind,
            geometry,
          } satisfies SpatiallyIndexedSkeletonPickData),
    firstNodePickId:
      numVertices === 0
        ? 0
        : pickIDs.register(layer, numVertices, 0n, {
            kind: kinds.nodeKind,
            geometry,
          } satisfies SpatiallyIndexedSkeletonPickData),
  };
}

function transformSpatiallyIndexedSkeletonPickedValue(
  pickState: PickState,
): bigint | undefined {
  return pickState.pickedSpatialSkeleton?.segmentId;
}

function updateSpatiallyIndexedSkeletonMouseState(
  base: SpatiallyIndexedSkeletonLayer,
  mouseState: MouseSelectionState,
  pickedOffset: number,
  data: SpatiallyIndexedSkeletonPickData | undefined,
): void {
  if (data === undefined) return;
  const { geometry } = data;
  if (data.kind === "edge" || data.kind === "segment-edge") {
    const segmentId = resolveSpatiallyIndexedSkeletonSegmentPick(
      geometry,
      pickedOffset,
      "edge",
    );
    if (segmentId !== undefined) {
      mouseState.pickedSpatialSkeleton = { segmentId };
    }
    return;
  }
  const pickedNode = resolveSpatiallyIndexedSkeletonNodePick(
    geometry,
    pickedOffset,
    base.editSession,
  );
  if (pickedNode === undefined) return;
  mouseState.pickedSpatialSkeleton = pickedNode;
  if (data.kind === "segment-node") return;
  const transform = base.displayState.transform.value;
  if (transform.error === undefined) {
    setMouseStatePositionFromSkeletonNode(
      mouseState,
      pickedNode.position,
      transform,
    );
  }
}

function makeSpatialSkeletonRenderLayerBackend(
  renderLayer: PerspectiveViewRenderLayer | SliceViewPanelRenderLayer,
  base: SpatiallyIndexedSkeletonLayer,
  spacingTarget: WatchableValueInterface<number>,
) {
  const { chunkManager, displayState } = base;
  const rpc = chunkManager.rpc!;
  const backend = renderLayer.registerDisposer(
    new ChunkRenderLayerFrontend(renderLayer.layerChunkProgressInfo),
  );
  backend.RPC_TYPE_ID = SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID;
  const share = <T>(value: WatchableValueInterface<T>) =>
    renderLayer.registerDisposer(
      SharedWatchableValue.makeFromExisting(rpc, value),
    ).rpcId;
  backend.initializeCounterpart(rpc, {
    chunkManager: chunkManager.rpcId,
    localPosition: share(base.localPosition),
    spacingTarget: share(spacingTarget),
    browseChunksNeeded: share(
      renderLayer.registerDisposer(
        makeCachedDerivedWatchableValue(
          (alpha) => alpha > 0,
          [displayState.hiddenObjectAlpha],
        ),
      ),
    ),
  });
  return backend;
}

function addSkeletonPanelOverlay(
  attachment: VisibleLayerInfo<
    PerspectivePanel | SliceViewPanel,
    ThreeDimensionalRenderLayerAttachmentState
  >,
  base: SpatiallyIndexedSkeletonLayer,
  renderOptions: ViewSpecificSkeletonRenderingOptions,
  view: SkeletonPanelView,
) {
  const nodeDiameter = attachment.registerDisposer(
    makeCachedDerivedWatchableValue(getSkeletonNodeDiameter, [
      renderOptions.mode,
      renderOptions.lineWidth,
    ]),
  );
  attachment.registerDisposer(
    attachment.view.addOverlay(
      new SkeletonPanelOverlay(
        attachment.view,
        base.overlayPrimitives,
        nodeDiameter,
        view,
      ),
    ),
  );
}

export function attachSpatiallyIndexedSkeletonLayer(
  base: SpatiallyIndexedSkeletonLayer,
  renderLayer: {
    transformedSources: TransformedSource[][];
    redrawNeeded: NullarySignal;
    backend: ChunkRenderLayerFrontend;
  },
  attachment: VisibleLayerInfo<
    LayerView,
    ThreeDimensionalRenderLayerAttachmentState
  >,
): void {
  const { redrawNeeded } = renderLayer;
  attachment.registerDisposer(
    registerNested(
      (context, transform, displayDimensionRenderInfo) => {
        const transformedSources = getVolumetricTransformedSources(
          displayDimensionRenderInfo,
          transform,
          () => base.multiscaleSource.getSources(),
          attachment.messages,
          renderLayer,
        );
        for (const scales of transformedSources) {
          for (const tsource of scales) {
            context.registerDisposer(tsource.source);
          }
        }
        attachment.view.flushBackendProjectionParameters();
        renderLayer.transformedSources = transformedSources;
        base.chunkManager.rpc!.invoke(
          SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
          {
            layer: renderLayer.backend.rpcId,
            view: attachment.view.rpcId,
            displayDimensionRenderInfo,
            sources: serializeAllTransformedSources(transformedSources),
          },
        );
        redrawNeeded.dispatch();
        return transformedSources;
      },
      base.displayState.transform,
      attachment.view.displayDimensionRenderInfo,
    ),
  );
}

export class PerspectiveViewSpatiallyIndexedSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  // Reused across frames, so a draw allocates nothing per visible chunk.
  private readonly visibleChunksScratch: VisibleChunk[] = [];
  private readonly wireframeShaderGetter: ParameterizedEmitterDependentShaderGetter<undefined>;
  backend: ChunkRenderLayerFrontend;

  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.wireframeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      base.gl,
      {
        memoizeKey: "skeleton/SpatiallyIndexedSkeletonChunkWireframe",
        parameters: constantWatchableValue(undefined),
        defineShader: (builder) => {
          builder.addUniform("highp mat4", "uChunkToClip");
          builder.addUniform("highp vec3", "uTranslation");
          builder.addUniform("highp vec3", "uChunkDataSize");
          builder.addVertexCode(glsl_getBoxEdgeVertexPosition);
          builder.setVertexMain(`
vec3 boxVertex = getBoxEdgeVertexPosition(gl_VertexID);
gl_Position = uChunkToClip * vec4(uTranslation + boxVertex * uChunkDataSize, 1.0);
`);
          builder.setFragmentMain(`emit(vec4(1.0, 1.0, 1.0, 1.0), 0u);`);
        },
      },
    );
    this.renderHelper = this.registerDisposer(new RenderHelper(base, false));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.browsePassLayerView, false),
    );
    this.renderOptions = base.displayState.skeletonRenderingOptions.params3d;

    this.backend = makeSpatialSkeletonRenderLayerBackend(
      this,
      base,
      base.displayState.spatialSkeletonSpacingTarget3d,
    );
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    const { renderOptions } = this;
    this.registerDisposer(
      renderOptions.mode.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch),
    );
    const spacingTarget3d = base.displayState.spatialSkeletonSpacingTarget3d;
    this.registerDisposer(
      spacingTarget3d.changed.add(this.redrawNeeded.dispatch),
    );
    const histogram3d = base.displayState.spatialSkeletonSpacingHistogram3d;
    this.registerDisposer(histogram3d.visibility.add(this.visibility));
  }

  attach(
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachSpatiallyIndexedSkeletonLayer(this.base, this, attachment);
    addSkeletonPanelOverlay(attachment, this.base, this.renderOptions, "3d");
  }

  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    const { objectAlpha, hiddenObjectAlpha } = this.base.displayState;
    const opaque =
      (objectAlpha.value == 1.0 &&
        (hiddenObjectAlpha.value == 1.0 || hiddenObjectAlpha.value == 0.0)) ||
      (objectAlpha.value == 0.0 && hiddenObjectAlpha.value == 1.0);
    return !opaque;
  }

  getValueAt(_position: Float32Array) {
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    return transformSpatiallyIndexedSkeletonPickedValue(pickState);
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: unknown,
  ) {
    updateSpatiallyIndexedSkeletonMouseState(
      this.base,
      mouseState,
      pickedOffset,
      data as SpatiallyIndexedSkeletonPickData | undefined,
    );
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      return;
    }
    const { displayState } = this.base;
    const spacingTarget = displayState.spatialSkeletonSpacingTarget3d.value;
    const histogram = displayState.spatialSkeletonSpacingHistogram3d;
    const frameNumber =
      this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
    const visibleChunks = this.base.updateVisibleChunksAndHistogram(
      this.transformedSources,
      renderContext.projectionParameters,
      spacingTarget,
      histogram,
      frameNumber,
      this.visibleChunksScratch,
    );
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      modelMatrix,
      visibleChunks,
    );
    if (renderContext.wireFrame) {
      this.drawChunkBoundsWireframe(renderContext, visibleChunks, modelMatrix);
    }
  }

  private drawChunkBoundsWireframe(
    renderContext: PerspectiveViewRenderContext,
    visibleChunks: VisibleChunk[],
    modelMatrix: mat4,
  ) {
    if (visibleChunks.length === 0 || !renderContext.emitColor) return;

    const { shader } = this.wireframeShaderGetter(renderContext.emitter);
    if (shader === null) return;
    const { gl } = this.base;
    shader.bind();
    const { viewProjectionMat } = renderContext.projectionParameters;

    mat4.multiply(tempMat4, viewProjectionMat, modelMatrix);
    gl.uniformMatrix4fv(shader.uniform("uChunkToClip"), false, tempMat4);

    for (const { chunk, chunkLayout } of visibleChunks) {
      const { size } = chunkLayout;
      const { chunkGridPosition } = chunk;
      gl.uniform3f(
        shader.uniform("uTranslation"),
        chunkGridPosition[0] * size[0],
        chunkGridPosition[1] * size[1],
        chunkGridPosition[2] * size[2],
      );
      gl.uniform3fv(shader.uniform("uChunkDataSize"), size);
      drawBoxEdges(gl, 1, 1);
    }
  }

  isReady(
    renderContext: PerspectiveViewReadyRenderContext,
    _attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    return this.base.isReady(
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.spatialSkeletonSpacingTarget3d.value,
    );
  }
}

export class SliceViewPanelSpatiallyIndexedSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper: RenderHelper;
  private browseRenderHelper: RenderHelper;
  private renderOptions: ViewSpecificSkeletonRenderingOptions;
  transformedSources: TransformedSource[][] = [];
  // Reused across frames, so a draw allocates nothing per visible chunk.
  private readonly visibleChunksScratch: VisibleChunk[] = [];
  backend: ChunkRenderLayerFrontend;
  constructor(public base: SpatiallyIndexedSkeletonLayer) {
    super();
    this.renderHelper = this.registerDisposer(new RenderHelper(base, true));
    this.browseRenderHelper = this.registerDisposer(
      new RenderHelper(base.browsePassLayerView, true),
    );
    this.renderOptions = base.displayState.skeletonRenderingOptions.params2d;
    this.backend = makeSpatialSkeletonRenderLayerBackend(
      this,
      base,
      base.displayState.spatialSkeletonSpacingTarget2d,
    );
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    const { renderOptions } = this;
    this.registerDisposer(
      renderOptions.mode.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch),
    );
    const { displayState: displayState2d } = base;
    const spacingTarget2d = displayState2d.spatialSkeletonSpacingTarget2d;
    this.registerDisposer(
      spacingTarget2d.changed.add(this.redrawNeeded.dispatch),
    );
    const histogram2d = displayState2d.spatialSkeletonSpacingHistogram2d;
    this.registerDisposer(histogram2d.visibility.add(this.visibility));
  }

  get gl() {
    return this.base.gl;
  }

  getValueAt(_position: Float32Array) {
    return undefined;
  }

  transformPickedValue(pickState: PickState) {
    return transformSpatiallyIndexedSkeletonPickedValue(pickState);
  }

  updateMouseState(
    mouseState: MouseSelectionState,
    _pickedValue: bigint,
    pickedOffset: number,
    data: unknown,
  ) {
    updateSpatiallyIndexedSkeletonMouseState(
      this.base,
      mouseState,
      pickedOffset,
      data as SpatiallyIndexedSkeletonPickData | undefined,
    );
  }

  attach(
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    super.attach(attachment);
    attachSpatiallyIndexedSkeletonLayer(this.base, this, attachment);
    addSkeletonPanelOverlay(attachment, this.base, this.renderOptions, "2d");
  }

  draw(
    renderContext: SliceViewPanelRenderContext,
    attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    const spacingTarget = displayState.spatialSkeletonSpacingTarget2d.value;
    const histogram = displayState.spatialSkeletonSpacingHistogram2d;
    const frameNumber =
      this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber;
    const visibleChunks = this.base.updateVisibleChunksAndHistogram(
      this.transformedSources,
      renderContext.sliceView.projectionParameters.value,
      spacingTarget,
      histogram,
      frameNumber,
      this.visibleChunksScratch,
    );
    const modelMatrix = update3dRenderLayerAttachment(
      displayState.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    this.base.draw(
      renderContext,
      this,
      this.renderHelper,
      this.browseRenderHelper,
      this.renderOptions,
      modelMatrix,
      visibleChunks,
    );
  }

  isReady(
    renderContext: SliceViewPanelReadyRenderContext,
    _attachment: VisibleLayerInfo<
      SliceViewPanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    const { displayState } = this.base;
    return this.base.isReady(
      this.transformedSources,
      renderContext.projectionParameters,
      displayState.spatialSkeletonSpacingTarget2d.value,
    );
  }
}

/**
 * @license
 * Copyright 2024 Google Inc.
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

import type { BrushHashTable } from "#src/brush_stroke/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import type { LayerView, VisibleLayerInfo } from "#src/layer/index.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";

import type {
  ChunkDisplayTransformParameters,
  ChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import type { VisibilityTrackedRenderLayer } from "#src/renderlayer.js";
import { SegmentColorShaderManager, SegmentStatedColorShaderManager } from "#src/segment_color.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";

import type { SliceViewPanelRenderContext } from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";

import { constantWatchableValue } from "#src/trackable_value.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import type { AnyConstructor, MixinConstructor } from "#src/util/mixin.js";
import { NullarySignal } from "#src/util/signal.js";
import type { ParameterizedContextDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import { parameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

interface BrushStrokeChunkRenderParameters {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
  modelClipBounds: Float32Array;
}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  chunkRenderParameters: BrushStrokeChunkRenderParameters | undefined;
}

export class BrushStrokeLayer extends RefCounted {
  public gpuBrushHashTable: GPUHashTable<any>;
  public gpuSegmentStatedColorHashTable: GPUHashTable<any> | undefined;
  public brushHashTableManager = new HashMapShaderManager("brushStroke");
  public segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  public segmentStatedColorShaderManager = new SegmentStatedColorShaderManager(
    "segmentStatedColor",
  );
  public visibleSegmentsHashManager = new HashSetShaderManager(
    "visibleSegments",
  );
  redrawNeeded = new NullarySignal();

  constructor(
    public chunkManager: ChunkManager,
    public brushHashTable: BrushHashTable,
    public displayState: SegmentationDisplayState,
  ) {
    super();
    // Create GPU hash table for brush strokes
    this.gpuBrushHashTable = this.registerDisposer(
      GPUHashTable.get(this.chunkManager.gl, brushHashTable),
    );
  }

  get gl() {
    return this.chunkManager.gl;
  }
}

function BrushStrokeRenderLayer<
  TBase extends AnyConstructor<VisibilityTrackedRenderLayer>,
>(Base: TBase) {
  class C extends (Base as AnyConstructor<VisibilityTrackedRenderLayer>) {
    private shaderGetter: ParameterizedContextDependentShaderGetter<
      any,
      undefined
    >;

    constructor(
      public base: Owned<BrushStrokeLayer>,
      public renderScaleHistogram: RenderScaleHistogram,
    ) {
      super();
      this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
      this.shaderGetter = parameterizedEmitterDependentShaderGetter(
        this,
        this.gl,
        {
          memoizeKey: "brushStroke",
          parameters: constantWatchableValue(undefined),
          defineShader: (builder: ShaderBuilder) => {
            this.defineShader(builder);
          },
        },
      );
    }

    get gl() {
      return this.base.chunkManager.gl;
    }

    defineShader(builder: ShaderBuilder) {
      // Add opacity uniforms to match parent segmentation layer
      builder.addUniform("highp float", "uSelectedAlpha");
      builder.addUniform("highp float", "uNotSelectedAlpha");

      // Add saturation uniform
      builder.addUniform("highp float", "uSaturation");

      // Add blending mode uniform for seamless integration
      builder.addUniform("highp float", "uBlendingEnabled");

      // 2D slice view implementation
      this.base.brushHashTableManager.defineShader(builder);
      this.base.segmentColorShaderManager.defineShader(builder);

      // Add segment stated color support for override colors
      this.base.segmentStatedColorShaderManager.defineShader(builder);

      // Add visibility checking to match segmentation layer
      builder.addUniform("highp uint", "uFlags");

      // Add the actual visibility hash table from segmentation layer
      this.base.visibleSegmentsHashManager.defineShader(builder);

      builder.addFragmentCode(`
                bool isSegmentVisible(uint64_t segmentId) {
                    // Same logic as segmentation layer
                    const uint SHOW_ALL_SEGMENTS_FLAG = 2u;
                    if ((uFlags & SHOW_ALL_SEGMENTS_FLAG) != 0u) {
                        return true; // All segments visible
                    } else {
                        // Check if segment is in visible set
                        return ${this.base.visibleSegmentsHashManager.hasFunctionName}(segmentId);
                    }
                }
            `);

      builder.addUniform("highp mat4", "uViewMatrix");
      builder.addUniform("highp mat4", "uProjectionMatrix");
      builder.addVarying("highp vec2", "vScreenPosition");

      const vertexShader = `
                vec2 positions[6] = vec2[6](
                    vec2(-1.0, -1.0),
                    vec2(1.0, -1.0),
                    vec2(1.0, 1.0),
                    vec2(-1.0, -1.0),
                    vec2(1.0, 1.0),
                    vec2(-1.0, 1.0)
                );
                vec2 pos = positions[gl_VertexID];
                gl_Position = vec4(pos, 0.0, 1.0);
                vScreenPosition = pos; // Pass NDC coordinates to fragment shader
            `;
      builder.setVertexMain(vertexShader);

      const fragmentShader = `
                // Coordinate transformation is working correctly, now enable brush lookup
                vec4 clipPos = vec4(vScreenPosition, 0.0, 1.0);
                    
                    // Transform from clip space to view space (inverse projection)
                    vec4 viewPos = inverse(uProjectionMatrix) * clipPos;
                    if (viewPos.w != 0.0) {
                        viewPos /= viewPos.w; // Perspective division
                    }
                    
                    // Transform from view space to world space (inverse view matrix)
                    vec4 worldPos4 = inverse(uViewMatrix) * viewPos;
                    vec3 worldPos = worldPos4.xyz;
                    
                    // Round to nearest voxel coordinate
                    ivec3 voxelPos = ivec3(round(worldPos));
                    
                    // Extract spatial (x, y, z) for the hash. voxelPos
                    // already lives in spatial XYZ for our datasets, so
                    // each component maps to its same-named hash slot.
                    // Must stay in lock-step with BrushHashTable.getBrushKey
                    // (CPU); changing the multipliers on one side breaks
                    // visualization on the other.
                    if (voxelPos.x < 0 || voxelPos.y < 0 || voxelPos.z < 0) {
                        // Negative coordinates - no brush strokes in negative space
                        discard;
                    }

                    uint x1 = uint(voxelPos.x);
                    uint y1 = uint(voxelPos.y);
                    uint z1 = uint(voxelPos.z);

                    uint h1 = ((x1 * 73u) * 1271u) ^ ((y1 * 513u) * 1345u) ^ ((z1 * 421u) * 675u);
                    uint h2 = ((x1 * 127u) * 337u) ^ ((y1 * 111u) * 887u) ^ ((z1 * 269u) * 325u);
                    
                    uint64_t key;
                    key.value[0] = h1;
                    key.value[1] = h2;
                    
                    uint64_t brushValue;
                    if (brushStroke_get(key, brushValue)) {
                        // value=0 marks "erased"
                        if (brushValue.value[0] == 0u && brushValue.value[1] == 0u) {
                            discard;
                        } else {
                            // Found brush stroke - use proper color resolution (check override colors first)
                            vec4 rgba;
                            vec3 segmentColor;
                            if (${this.base.segmentStatedColorShaderManager.getFunctionName}(brushValue, rgba)) {
                                // Use override color from segment properties
                                segmentColor = rgba.rgb;
                            } else {
                                // Fall back to computed color
                                segmentColor = segmentColorHash(brushValue);
                            }

                            // Apply saturation mixing (same as segmentation layer)
                            vec3 baseColor = mix(vec3(1.0, 1.0, 1.0), segmentColor, uSaturation);

                            // Calculate final color and alpha to simulate being part of segmentation layer
                            vec3 finalColor;
                            float outputAlpha;

                            if (uBlendingEnabled > 0.5) {
                                // Multiple layers - simulate being part of segmentation layer
                                bool isVisible = isSegmentVisible(brushValue);
                                float targetAlpha = isVisible ? uSelectedAlpha : uNotSelectedAlpha;

                                // Pre-multiply the color by target alpha and use full opacity for replacement
                                // This makes the brush stroke appear with the same opacity as segmentation
                                finalColor = baseColor * targetAlpha;
                                outputAlpha = 1.0;
                            } else {
                                // Single layer - replace pixels completely
                                finalColor = baseColor;
                                outputAlpha = 1.0;
                            }

                            emit(vec4(finalColor, outputAlpha), 0u);
                        }
                    } else {
                        // No brush stroke - discard fragment
                        discard;
                    }
                `;
      builder.setFragmentMain(fragmentShader);
    }

    initializeShader(
      shader: ShaderProgram,
      renderContext: SliceViewPanelRenderContext,
    ) {
      const { gl } = this;
      const {
        gpuBrushHashTable,
        brushHashTableManager,
        segmentColorShaderManager,
        displayState,
      } = this.base;

      // Initialize brush hash table for both views
      brushHashTableManager.enable(gl, shader, gpuBrushHashTable);

      // Initialize segment color shader
      const colorGroupState = displayState.segmentationColorGroupState.value;
      segmentColorShaderManager.enable(
        gl,
        shader,
        colorGroupState.segmentColorHash.value,
      );

      // Initialize segment stated color shader for override colors
      const segmentStatedColors = displayState.useTempSegmentStatedColors2d.value
        ? displayState.tempSegmentStatedColors2d.value
        : displayState.segmentStatedColors.value;

      if (segmentStatedColors.size > 0) {
        let gpuSegmentStatedColorHashTable = this.base.gpuSegmentStatedColorHashTable;
        if (
          gpuSegmentStatedColorHashTable === undefined ||
          gpuSegmentStatedColorHashTable.hashTable !== segmentStatedColors.hashTable
        ) {
          gpuSegmentStatedColorHashTable?.dispose();
          this.base.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
            GPUHashTable.get(gl, segmentStatedColors.hashTable);
        }
        this.base.segmentStatedColorShaderManager.enable(
          gl,
          shader,
          gpuSegmentStatedColorHashTable,
        );
      }

      // Set opacity uniforms to match parent segmentation layer
      const selectedAlpha = (displayState as any).selectedAlpha.value;
      const notSelectedAlpha = (displayState as any).notSelectedAlpha.value;
      const saturation = displayState.saturation.value;

      // Get visibility information from segmentation display state
      const segmentationGroupState = displayState.segmentationGroupState.value;
      const visibleSegments = segmentationGroupState.visibleSegments;

      gl.uniform1f(shader.uniform("uSelectedAlpha"), selectedAlpha);
      gl.uniform1f(shader.uniform("uNotSelectedAlpha"), notSelectedAlpha);
      gl.uniform1f(shader.uniform("uSaturation"), saturation);

      // Set up visibility checking flags (same as segmentation layer)
      let flags = 0;
      if (visibleSegments.hashTable.size === 0) {
        flags |= 2; // SHOW_ALL_SEGMENTS_FLAG
      }
      gl.uniform1ui(shader.uniform("uFlags"), flags);

      // Set blending mode for seamless integration
      const layerCount = renderContext.sliceView.visibleLayerList.length;
      // Multiple layers present when there's more than just the segmentation layer
      const hasMultipleLayers = layerCount > 1;
      const blendingValue = hasMultipleLayers ? 1.0 : 0.0;
      gl.uniform1f(shader.uniform("uBlendingEnabled"), blendingValue);

      // 2D slice view: Set up matrices and visibility
      const { visibleSegmentsHashManager } = this.base;
      // Get the GPU hash table from the visible segments hash table
      const gpuHashTable = GPUHashTable.get(gl, visibleSegments.hashTable);
      visibleSegmentsHashManager.enable(gl, shader, gpuHashTable);

      const sliceViewProjectionParameters =
        renderContext.sliceView.projectionParameters.value;
      const { viewMatrix, projectionMat } = sliceViewProjectionParameters;

      // Set view matrix (transforms world coordinates to view coordinates)
      gl.uniformMatrix4fv(shader.uniform("uViewMatrix"), false, viewMatrix);

      // Set projection matrix (transforms view coordinates to clip coordinates)
      gl.uniformMatrix4fv(
        shader.uniform("uProjectionMatrix"),
        false,
        projectionMat,
      );
    }

    draw(
      renderContext: SliceViewPanelRenderContext,
      _attachment: VisibleLayerInfo<LayerView, AttachmentState>,
    ) {
      const { gl } = this;

      if (this.base.brushHashTable.size <= 0) {
        return;
      }

      const shader = this.getShader(renderContext);
      if (shader === null) {
        return;
      }

      shader.bind();
      this.initializeShader(shader, renderContext);

      // Set up seamless blending with segmentation layer
      const layerCount = renderContext.sliceView.visibleLayerList.length;
      const hasMultipleLayers = layerCount > 1;

      if (hasMultipleLayers) {
        // Multiple layers present - blend normally
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        // Only segmentation layer - replace underlying pixels to appear seamless
        // Disable blending so brush strokes replace segmentation pixels completely
        gl.disable(gl.BLEND);
      }

      // Draw full-screen quad
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Clean up blending state
      gl.disable(gl.BLEND);
    }

    private getShader(renderContext: SliceViewPanelRenderContext) {
      const result = this.shaderGetter(renderContext.emitter);
      return result.shader;
    }
  }
  return C as MixinConstructor<typeof C, TBase>;
}

export const SliceViewBrushStrokeLayer = BrushStrokeRenderLayer(
  SliceViewPanelRenderLayer,
);

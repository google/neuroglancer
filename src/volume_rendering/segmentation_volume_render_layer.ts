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

import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import type { SegmentationGroupState } from "#src/segmentation_display_state/frontend.js";
import { registerRedrawWhenSegmentationDisplayStateChanged } from "#src/segmentation_display_state/frontend.js";
import type { SliceViewSegmentationDisplayState } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { EquivalencesHashMap } from "#src/sliceview/volume/segmentation_renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { GL } from "#src/webgl/context.js";
import type { ParameterizedShaderGetterResult } from "#src/webgl/dynamic_shader.js";
import type { ChunkFormat } from "#src/sliceview/volume/frontend.js";
import type { ShaderControlsBuilderState } from "#src/webgl/shader_ui_controls.js";
import type {
  ShaderBuilder,
  ShaderModule,
  ShaderProgram,
} from "#src/webgl/shader.js";
import type {
  VolumeRenderingRenderLayerOptions,
  VolumeRenderingShaderParameters,
} from "#src/volume_rendering/volume_render_layer.js";
import { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";

export interface SegmentationVolumeRenderingRenderLayerOptions
  extends Omit<VolumeRenderingRenderLayerOptions, "shaderControlState"> {
  segmentationDisplayState: SliceViewSegmentationDisplayState;
  /**
   * Linear opacity in [0, 1] applied to every emitted (visible) voxel, in
   * addition to any per-segment alpha returned by the user shader. Distinct
   * from `gain`, which is an exponential brightness multiplier.
   */
  opacity3d: WatchableValueInterface<number>;
}

/**
 * Volumetric (ray-marched) rendering of a segmentation volume. Each ray sample
 * reads the raw segment ID (nearest-neighbor), maps it through any
 * equivalences, gates visibility against the visible-segment set, and emits the
 * segment color (hash / stated / default / user-shader) with the layer's 3D
 * opacity. Background (ID 0, when hidden) and non-visible segments are emitted
 * fully transparent so the interior of the volume remains see-through.
 */
export class SegmentationVolumeRenderingRenderLayer extends VolumeRenderingRenderLayer {
  public readonly segmentationGroupState: SegmentationGroupState;
  public segmentationDisplayState: SliceViewSegmentationDisplayState;
  private opacity3d: WatchableValueInterface<number>;

  private hashTableManager = new HashSetShaderManager("visibleSegments");
  private gpuHashTable;
  private gpuTemporaryHashTable;
  private equivalencesShaderManager = new HashMapShaderManager("equivalences");
  private equivalencesHashMap;
  private temporaryEquivalencesHashMap;
  private gpuEquivalencesHashTable;
  private gpuTemporaryEquivalencesHashTable;

  constructor(options: SegmentationVolumeRenderingRenderLayerOptions) {
    const { segmentationDisplayState } = options;
    super({
      ...options,
      shaderControlState:
        segmentationDisplayState.segmentColorShaderControlState,
    });
    this.segmentationDisplayState = segmentationDisplayState;
    this.opacity3d = options.opacity3d;
    this.segmentationGroupState =
      segmentationDisplayState.segmentationGroupState.value;

    this.gpuHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        this.segmentationGroupState.visibleSegments.hashTable,
      ),
    );
    this.gpuTemporaryHashTable = GPUHashTable.get(
      this.gl,
      this.segmentationGroupState.temporaryVisibleSegments.hashTable,
    );
    this.equivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.segmentEquivalences.disjointSets,
    );
    this.temporaryEquivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.temporarySegmentEquivalences.disjointSets,
    );
    this.gpuEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap),
    );
    this.gpuTemporaryEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.temporaryEquivalencesHashMap.hashMap),
    );

    registerRedrawWhenSegmentationDisplayStateChanged(
      segmentationDisplayState,
      this,
    );
    this.registerDisposer(
      this.opacity3d.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      segmentationDisplayState.segmentColorShaderControlState.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    this.registerDisposer(
      segmentationDisplayState.segmentationColorUserShader.usedProperties.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    this.registerDisposer(
      segmentationDisplayState.segmentationColorUserShader.shaderParameters.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
  }

  private get hasEquivalences() {
    return this.segmentationGroupState.segmentEquivalences.size !== 0;
  }

  // Segmentation volume rendering never builds data-value histograms (the
  // volume contains categorical segment IDs, not a continuous signal). This
  // disables the histogram repass entirely.
  getDataHistogramCount() {
    return 0;
  }

  protected getShaderContextKey(context: {
    emitter: ShaderModule;
    chunkFormat: ChunkFormat;
    wireFrame: boolean;
  }): string {
    const { value: colorParams } =
      this.segmentationDisplayState.segmentationColorUserShader
        .shaderParameters;
    const { usedProperties } =
      this.segmentationDisplayState.segmentationColorUserShader;
    return (
      `${super.getShaderContextKey(context)}` +
      `:eq=${this.hasEquivalences}` +
      `:z0=${this.segmentationDisplayState.hideSegmentZero.value}` +
      `:base=${this.segmentationDisplayState.baseSegmentColoring.value}` +
      `:def=${colorParams.hasSegmentDefaultColor}` +
      `:stated=${colorParams.hasSegmentStatedColors}` +
      `:props=${Array.from(usedProperties.value).sort().join(",")}`
    );
  }

  protected defineUserMain(builder: ShaderBuilder) {
    const { segmentationDisplayState } = this;
    this.hashTableManager.defineShader(builder);
    segmentationDisplayState.segmentationColorUserShader.defineShader(
      builder,
      /*fragment=*/ true,
    );
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);
    if (this.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  return value;
}
`);
    }
    builder.addUniform("bool", "uShowAllSegments");
    builder.addUniform("highp float", "uOpacity3d");

    const hideSegmentZero = segmentationDisplayState.hideSegmentZero.value;
    const valueForColor = segmentationDisplayState.baseSegmentColoring.value
      ? "baseValue"
      : "value";

    builder.addFragmentCode(`
void userMain() {
  uint64_t baseValue = getUint64DataValue();
  uint64_t value = getMappedObjectId(baseValue);
${
  hideSegmentZero
    ? `  if (value.value[0] == 0u && value.value[1] == 0u) {
    emitTransparent();
    return;
  }
`
    : ""
}
  bool has = uShowAllSegments || ${this.hashTableManager.hasFunctionName}(value);
  if (!has) {
    emitTransparent();
    return;
  }
  vec4 rgba = segmentColorUserShader(${valueForColor});
  float alpha = uOpacity3d;
  if (rgba.a >= 0.0) {
    alpha *= rgba.a;
  }
  emitRGBA(vec4(rgba.rgb, alpha));
}
`);
  }

  protected bindShaderControls(
    gl: GL,
    shader: ShaderProgram,
    shaderResult: ParameterizedShaderGetterResult<
      ShaderControlsBuilderState,
      VolumeRenderingShaderParameters
    >,
  ) {
    const { segmentationGroupState, segmentationDisplayState } = this;
    const visibleSegments = getVisibleSegments(segmentationGroupState);
    const ignoreNullSegmentSet =
      segmentationDisplayState.ignoreNullVisibleSet.value;
    const showAllSegments =
      visibleSegments.hashTable.size === 0 && ignoreNullSegmentSet;
    gl.uniform1ui(shader.uniform("uShowAllSegments"), showAllSegments ? 1 : 0);
    gl.uniform1f(shader.uniform("uOpacity3d"), this.opacity3d.value);

    this.hashTableManager.enable(
      gl,
      shader,
      segmentationGroupState.useTemporaryVisibleSegments.value
        ? this.gpuTemporaryHashTable
        : this.gpuHashTable,
    );
    if (this.hasEquivalences) {
      const useTemp =
        segmentationGroupState.useTemporarySegmentEquivalences.value;
      (useTemp
        ? this.temporaryEquivalencesHashMap
        : this.equivalencesHashMap
      ).update();
      this.equivalencesShaderManager.enable(
        gl,
        shader,
        useTemp
          ? this.gpuTemporaryEquivalencesHashTable
          : this.gpuEquivalencesHashTable,
      );
    }
    segmentationDisplayState.segmentationColorUserShader.enable(
      gl,
      shader,
      shaderResult.parameters.parseResult.controls,
    );
  }

  protected endShaderControls(gl: GL, shader: ShaderProgram) {
    this.segmentationDisplayState.segmentationColorUserShader.disable(
      gl,
      shader,
    );
    this.hashTableManager.disable(gl, shader);
    if (this.hasEquivalences) {
      this.equivalencesShaderManager.disable(gl, shader);
    }
  }
}

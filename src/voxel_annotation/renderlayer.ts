/**
 * @license
 * Copyright 2025 Google Inc.
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

import { SegmentColorShaderManager } from "#src/segment_color.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { RenderLayerOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

type EmptyParams = Record<string, never>;

export class VoxelAnnotationRenderLayer extends SliceViewVolumeRenderLayer<EmptyParams> {
  private segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  private forcedSourceIndexLock: number | undefined;

  /** Expose forced LOD index to SliceView.filterVisibleSources when a stroke is active. */
  getForcedSourceIndexOverride(): number | undefined {
    return this.forcedSourceIndexLock;
  }

  /** Set or clear the forced LOD index. Triggers a visible-sources recomputation. */
  setForcedSourceIndexLock(index: number | undefined): void {
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(
          "setForcedSourceIndexLock: index must be a non-negative integer",
        );
      }
    }
    this.forcedSourceIndexLock = index;
    // Nudge the sliceview to recompute visible sources by toggling the render scale target.
    const current = this.renderScaleTarget.value;
    const epsilon = 1e-9;
    this.renderScaleTarget.value = current + epsilon;
    this.renderScaleTarget.value = current;
    // Ensure a redraw as well.
    this.redrawNeeded.dispatch();
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: RenderLayerOptions<EmptyParams>,
  ) {
    super(multiscaleSource, {
      ...options,
      shaderParameters:
        options.shaderParameters ?? constantWatchableValue({} as EmptyParams),
      encodeShaderParameters: () => 0,
    });
  }

  defineShader(builder: ShaderBuilder) {
    // Define segment color hashing function and uint64 helpers
    this.segmentColorShaderManager.defineShader(builder);
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);

    builder.setFragmentMain(`
  uint64_t v64 = getUint64DataValue();
  vec3 rgb = segmentColorHash(v64);
  // Transparent if zero, otherwise semi-opaque
  bool isZero = (v64.value[0] == 0u && v64.value[1] == 0u);
  float alpha = isZero ? 0.0 : 0.5;
  emit(vec4(rgb, alpha));
  `);

    /**
     * Notes on the shader building:
     * - The shader is not built until the first draw call, in the `draw` method.
     * - the SliceViewVolumeRenderLayer build a shader getter in the constructor, the getter builds the shader and memoize it.
     * - when the build process fails no error is thrown, this makes a wrong shader hard to debug.
     * - here we add a try/catch to log the error if the build fails, its soul purpose is for debugging.
     */
    try {
      builder.build();
    } catch (e) {
      builder.print();
      console.error(e);
    }
  }

  initializeShader(
    _sliceView: any,
    shader: ShaderProgram,
    _parameters: EmptyParams,
    _fallback: boolean,
  ) {
    // Use default seed 0 to match UI hashing (SegmentColorHash.getDefault())
    this.segmentColorShaderManager.enable(this.gl, shader, 0);
  }
}

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

import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { RenderLayerOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

/**
 * This is a specialized rendering layer that knows how to take data from a `MultiscaleVolumeChunkSource`
 * and render it as a 2D slice in the Neuroglancer viewer.
 *
 * Its main responsibilities include:
 * - Data Request: It requests the necessary 3D data chunks from the `MultiscaleVolumeChunkSource` that intersect with the current 2D slice being viewed.
 * - WebGL Management: It manages the WebGL resources (like textures and buffers) required to efficiently upload and display this 3D data as a 2D image.
 * - Shader Logic: It provides the core shader program (via its `defineShader` method) that interprets the raw 3D volume data (e.g., a voxel value) and converts it into a visual representation (e.g., a color).
 * - Interaction: It handles interactions like picking, allowing you to identify the specific 3D voxel or segment under the mouse cursor on the 2D slice.
 */
type EmptyParams = Record<string, never>;

export class VoxelAnnotationRenderLayer extends SliceViewVolumeRenderLayer<EmptyParams> {

  override draw(renderContext: any) {
    const { sliceView } = renderContext;
    const layerInfo = sliceView.visibleLayers.get(this);
    if (layerInfo === undefined) {
      // Visible layers not ready yet; skip drawing this frame.
      return;
    }
    console.log("drawn")
    super.draw(renderContext);
  }
  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: RenderLayerOptions<EmptyParams>,
  ) {
    console.log('$$$$$$$ VoxelAnnotationRenderLayer creation with options:', options);
    super(multiscaleSource, {
      ...options,
      shaderParameters: options.shaderParameters ?? constantWatchableValue({} as EmptyParams),
      encodeShaderParameters: () => 0,
    });
    console.log('###### VoxelAnnotationRenderLayer created with options:', options);
  }

  defineShader(builder: ShaderBuilder) {
    builder.setFragmentMain(`
  float t = float(getDataValue().value);
  vec4 color = t > 10.0 ? vec4(1.0, 1.0, 0.0, 1.0) : vec4(clamp(t, 0.0, 1.0), 0.0, 0.0, t > 0.0 ? 0.3 : 0.0);
  emit(color);
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
    }catch (e) {
      builder.print()
      console.error(e)
    }
  }

  initializeShader(
    _sliceView: any,
    _shader: ShaderProgram,
    _parameters: EmptyParams,
    _fallback: boolean,
  ) {
    // No specific uniforms for the checkerboard yet, but this is where they would go.
  }
}

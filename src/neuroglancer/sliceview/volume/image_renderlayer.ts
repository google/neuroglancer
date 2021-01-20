/**
 * @license
 * Copyright 2016 Google Inc.
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

import {SliceView} from 'neuroglancer/sliceview/frontend';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RenderLayerBaseOptions, SliceViewVolumeRenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {BLEND_FUNCTIONS, BLEND_MODES, TrackableBlendModeValue} from 'neuroglancer/trackable_blend';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {glsl_COLORMAPS} from 'neuroglancer/webgl/colormaps';
import {makeTrackableFragmentMain, shaderCodeWithLineDirective, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {addControlsToBuilder, getFallbackBuilderState, parseShaderUiControls, setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';

const DEFAULT_FRAGMENT_MAIN = `#uicontrol invlerp normalized
void main() {
  emitGrayscale(normalized());
}
`;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export interface ImageRenderLayerOptions extends RenderLayerBaseOptions {
  shaderError: WatchableShaderError;
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
}

export function defineImageLayerShader(
    builder: ShaderBuilder, shaderBuilderState: ShaderControlsBuilderState) {
  builder.addFragmentCode(`
#define VOLUME_RENDERING false

void emitRGBA(vec4 rgba) {
  emit(vec4(rgba.rgb, rgba.a * uOpacity));
}
void emitRGB(vec3 rgb) {
  emit(vec4(rgb, uOpacity));
}
void emitGrayscale(float value) {
  emit(vec4(value, value, value, uOpacity));
}
void emitTransparent() {
  emit(vec4(0.0, 0.0, 0.0, 0.0));
}
`);
  builder.addFragmentCode(glsl_COLORMAPS);
  addControlsToBuilder(shaderBuilderState, builder);
  builder.setFragmentMainFunction(shaderCodeWithLineDirective(shaderBuilderState.parseResult.code));
}

export class ImageRenderLayer extends SliceViewVolumeRenderLayer<ShaderControlsBuilderState> {
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
  constructor(multiscaleSource: MultiscaleVolumeChunkSource, options: ImageRenderLayerOptions) {
    const {opacity, blendMode, shaderControlState} = options;
    super(multiscaleSource, {
      ...options,
      fallbackShaderParameters:
          new WatchableValue(getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN, {
            imageData: {
              dataType: multiscaleSource.dataType,
              channelRank: options.channelCoordinateSpace?.value?.rank ?? 0,
            }
          }))),
      encodeShaderParameters: p => p.key,
      shaderParameters: shaderControlState.builderState,
      dataHistogramSpecifications: shaderControlState.histogramSpecifications,
    });
    this.shaderControlState = shaderControlState;
    this.opacity = opacity;
    this.blendMode = blendMode;
    this.registerDisposer(opacity.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(blendMode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(shaderControlState.changed.add(this.redrawNeeded.dispatch));
  }

  defineShader(builder: ShaderBuilder, shaderBuilderState: ShaderControlsBuilderState) {
    if (shaderBuilderState.parseResult.errors.length !== 0) {
      throw new Error('Invalid UI control specification');
    }
    builder.addUniform('highp float', 'uOpacity');
    defineImageLayerShader(builder, shaderBuilderState);
  }

  initializeShader(
      _sliceView: SliceView, shader: ShaderProgram, parameters: ShaderControlsBuilderState) {
    const {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    setControlsInShader(gl, shader, this.shaderControlState, parameters.parseResult.controls);
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number) {
    const blendModeValue = this.blendMode.value;
    if (blendModeValue === BLEND_MODES.ADDITIVE || renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      BLEND_FUNCTIONS.get(blendModeValue)!(gl);
    } else {
      gl.disable(WebGL2RenderingContext.BLEND);
    }
  }
}

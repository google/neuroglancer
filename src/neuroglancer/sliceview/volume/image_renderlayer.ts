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
import {RenderLayer, RenderLayerOptions} from 'neuroglancer/sliceview/volume/renderlayer';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {BLEND_FUNCTIONS, BLEND_MODES, TrackableBlendModeValue} from 'neuroglancer/trackable_blend';
import glsl_COLORMAPS from 'neuroglancer/webgl/colormaps.glsl';
import {makeTrackableFragmentMain} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {addControlsToBuilder, setControlsInShader, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_IMAGE_RENDERLAYER_FRAGMENT_MAIN_START';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitGrayscale(toNormalized(getDataValue()));
}
`;


export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export interface ImageRenderLayerOptions extends RenderLayerOptions {
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
}

export class ImageRenderLayer extends RenderLayer {
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
  constructor(multiscaleSource: MultiscaleVolumeChunkSource, options: ImageRenderLayerOptions) {
    super(multiscaleSource, options);
    const {opacity, blendMode, shaderControlState} = options;
    this.shaderControlState = shaderControlState;
    this.opacity = opacity;
    this.blendMode = blendMode;
    this.registerDisposer(opacity.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(blendMode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(shaderControlState.fragmentMain.changed.add(() => {
      this.shaderGetter.invalidateShader();
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(shaderControlState.changed.add(this.redrawNeeded.dispatch));
  }

  protected getShaderKey() {
    return `volume.ImageRenderLayer:${JSON.stringify(this.shaderControlState.fragmentMain.value)}`;
  }

  protected defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addUniform('highp float', 'uOpacity');
    builder.addFragmentCode(`
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
    const controls = this.shaderControlState.controls.value;
    if (controls !== undefined) {
      addControlsToBuilder(controls, builder);
    }
    builder.setFragmentMainFunction(
        FRAGMENT_MAIN_START + '\n' + this.shaderControlState.processedFragmentMain.value);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    if (shader === undefined) {
      return undefined;
    }
    let {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    setControlsInShader(gl, shader, this.shaderControlState);
    return shader;
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number) {
    const blendModeValue = this.blendMode.value;
    if (blendModeValue === BLEND_MODES.ADDITIVE || renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      BLEND_FUNCTIONS.get(blendModeValue)!(gl);
    }
  }
}

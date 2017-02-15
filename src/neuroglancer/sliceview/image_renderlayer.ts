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

import {VolumeSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {makeTrackableFragmentMain, makeWatchableShaderError, TrackableFragmentMain} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_IMAGE_RENDERLAYER_FRAGMENT_MAIN_START';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitGrayscale(toNormalized(getDataValue()));
}
`;

const glsl_COLORMAPS = require<string>('neuroglancer/webgl/colormaps.glsl');

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export class ImageRenderLayer extends RenderLayer {
  fragmentMain: TrackableFragmentMain;
  opacity: TrackableAlphaValue;
  constructor(multiscaleSource: MultiscaleVolumeChunkSource, {
    opacity = trackableAlphaValue(0.5),
    fragmentMain = getTrackableFragmentMain(),
    shaderError = makeWatchableShaderError(),
    volumeSourceOptions = <VolumeSourceOptions>{},
  } = {}) {
    super(multiscaleSource, {shaderError, volumeSourceOptions});
    this.fragmentMain = fragmentMain;
    this.opacity = opacity;
    this.registerDisposer(opacity.changed.add(() => { this.redrawNeeded.dispatch(); }));
    this.registerDisposer(fragmentMain.changed.add(() => {
      this.shaderUpdated = true;
      this.redrawNeeded.dispatch();
    }));
  }

  getShaderKey() { return `sliceview.ImageRenderLayer:${JSON.stringify(this.fragmentMain.value)}`; }

  defineShader(builder: ShaderBuilder) {
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
    builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + this.fragmentMain.value);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    return shader;
  }
};

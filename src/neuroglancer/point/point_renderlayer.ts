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

import {PointSourceOptions} from 'neuroglancer/point/base';
import {MultiscalePointChunkSource} from 'neuroglancer/point/frontend';
import {RenderLayer} from 'neuroglancer/point/frontend';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {vec3} from 'neuroglancer/util/geom';
import {makeTrackableFragmentMain, makeWatchableShaderError, TrackableFragmentMain} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_POINT_RENDERLAYER_FRAGMENT_MAIN_START';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitRGB(uColor);
}
`;

const glsl_COLORMAPS = require<string>('neuroglancer/webgl/colormaps.glsl');

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export class PointRenderLayer extends RenderLayer {
  opacity: TrackableAlphaValue;
  constructor(multiscaleSource: MultiscalePointChunkSource, {
    opacity = trackableAlphaValue(0.5),
    shaderError = makeWatchableShaderError(),
    sourceOptions = <PointSourceOptions>{},
  } = {}) {
    super(multiscaleSource, {shaderError, sourceOptions});
    this.opacity = opacity;
    this.registerDisposer(opacity.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
  }

  getShaderKey() {
    return `point.PointRenderLayer`;
  }

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
    builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + DEFAULT_FRAGMENT_MAIN);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    gl.uniform3fv(
        shader.uniform('uColor'), vec3.fromValues(1.0, 0.0, 0.5));  // TODO accept from user
    return shader;
  }
};

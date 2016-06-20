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

import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export function trivialTextureShader(gl: GL): ShaderProgram {
  return gl.memoize.get('trivialTextureShader', () => {
    let builder = new ShaderBuilder(gl);
    builder.addVarying('vec2', 'vTexCoord');
    builder.addUniform('sampler2D', 'uSampler');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.setFragmentMain('gl_FragColor = texture2D(uSampler, vTexCoord);');
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.addAttribute('vec2', 'aTexCoord');
    builder.setVertexMain(
        'vTexCoord = aTexCoord; gl_Position = uProjectionMatrix * aVertexPosition;');
    return builder.build();
  });
}

export function trivialColorShader(gl: GL): ShaderProgram {
  return gl.memoize.get('trivialColorShader', () => {
    let builder = new ShaderBuilder(gl);
    builder.addVarying('vec4', 'vColor');
    builder.setFragmentMain('gl_FragColor = vColor;');
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.addAttribute('vec4', 'aColor');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.setVertexMain('vColor = aColor; gl_Position = uProjectionMatrix * aVertexPosition;');
    return builder.build();
  });
}

export function trivialUniformColorShader(gl: GL): ShaderProgram {
  return gl.memoize.get('trivialUniformColorShader', () => {
    let builder = new ShaderBuilder(gl);
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.addUniform('vec4', 'uColor');
    builder.setFragmentMain('gl_FragColor = uColor;');
    builder.setVertexMain('gl_Position = uProjectionMatrix * aVertexPosition;');
    return builder.build();
  });
}

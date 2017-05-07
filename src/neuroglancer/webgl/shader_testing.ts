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

import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_debugFunctions} from 'neuroglancer/webgl/shader_lib';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {webglTest} from 'neuroglancer/webgl/testing';

export class FragmentShaderTester extends RefCounted {
  builder = new ShaderBuilder(this.gl);
  shader: ShaderProgram;
  offscreenFramebuffer: FramebufferConfiguration<TextureBuffer>;
  private vertexPositionsBuffer = getSquareCornersBuffer(this.gl, -1, -1, 1, 1);

  constructor(public gl: GL, colorBuffers: TextureBuffer[]) {
    super();
    let {builder} = this;
    this.offscreenFramebuffer = new FramebufferConfiguration(this.gl, {colorBuffers});
    builder.addFragmentExtension('GL_EXT_draw_buffers');
    builder.addAttribute('vec4', 'shader_testing_aVertexPosition');
    builder.setVertexMain(`gl_Position = shader_testing_aVertexPosition;`);
    builder.addFragmentCode(glsl_debugFunctions);
  }
  build() { this.shader = this.builder.build(); }
  execute() {
    this.offscreenFramebuffer.bind(1, 1);
    let {gl, shader} = this;
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    let aVertexPosition = shader.attribute('shader_testing_aVertexPosition');
    this.vertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    gl.disableVertexAttribArray(aVertexPosition);
    this.offscreenFramebuffer.unbind();
  }
  readBytes(index = 0) { return this.offscreenFramebuffer.readPixel(index, 0, 0); }

  readVec4(index?: number) {
    let x = this.readBytes(index);
    return vec4.fromValues(x[0] / 255, x[1] / 255, x[2] / 255, x[3] / 255);
  }

  readFloat(index?: number) {
    let bytes = this.readBytes(index);
    let dataView = new DataView(bytes.buffer, 0, 4);
    return dataView.getFloat32(0, /*littleEndian=*/true);
  }

  /**
   * Interprets the 4-byte RGBA value as a native uint32.
   */
  readUint32(index?: number) {
    let bytes = this.readBytes(index);
    return new Uint32Array(bytes.buffer)[0];
  }
};

export function fragmentShaderTest(numOutputs: number, f: (tester: FragmentShaderTester) => void) {
  webglTest(gl => {
    let tester = new FragmentShaderTester(gl, makeTextureBuffers(gl, numOutputs));
    try {
      f(tester);
    } finally {
      tester.dispose();
    }
  });
}

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
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {webglTest} from 'neuroglancer/webgl/testing';

export interface FragmentShaderTestOutputs {
  [key: string]: 'uint' | 'float';
}

function makeTextureBuffersForOutputs(gl: GL, outputs: FragmentShaderTestOutputs): TextureBuffer[] {
  return Object.keys(outputs).map(key => {
    const t = outputs[key];
    if (t === 'uint') {
      return new TextureBuffer(
          gl, WebGL2RenderingContext.R32UI, WebGL2RenderingContext.RED_INTEGER,
          WebGL2RenderingContext.UNSIGNED_INT);
    } else {
      return new TextureBuffer(
          gl, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT);
    }
  });
}

export class FragmentShaderTester<Outputs extends FragmentShaderTestOutputs> extends RefCounted {
  builder = new ShaderBuilder(this.gl);
  shader: ShaderProgram;
  offscreenFramebuffer: FramebufferConfiguration<TextureBuffer>;
  private vertexPositionsBuffer = getSquareCornersBuffer(this.gl, -1, -1, 1, 1);

  constructor(public gl: GL, public outputs: Outputs) {
    super();
    let {builder} = this;
    this.offscreenFramebuffer = new FramebufferConfiguration(
        this.gl, {colorBuffers: makeTextureBuffersForOutputs(gl, outputs)});
    builder.addAttribute('vec4', 'shader_testing_aVertexPosition');
    builder.setVertexMain(`gl_Position = shader_testing_aVertexPosition;`);
    Object.keys(outputs).forEach((key, index) => {
      const t = outputs[key];
      builder.addOutputBuffer(t === 'uint' ? 'highp uint' : 'highp float', key, index);
    });
  }
  build() {
    this.shader = this.builder.build();
  }
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

  get values(): {[P in keyof Outputs]: number} {
    const values = {} as any;
    for (const key of Object.keys(this.outputs)) {
      values[key] = this.read(key);
    }
    return values;
  }

  read(key: keyof Outputs): number {
    const t = this.outputs[key];
    const index = Object.keys(this.outputs).indexOf(key as string);
    if (t === 'uint') {
      return this.offscreenFramebuffer.readPixelUint32(index, 0, 0);
    } else {
      return this.offscreenFramebuffer.readPixelFloat32(index, 0, 0);
    }
  }

  readBytes(index = 0) {
    return this.offscreenFramebuffer.readPixel(index, 0, 0);
  }

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
}

export function fragmentShaderTest<Outputs extends FragmentShaderTestOutputs>(
    outputs: Outputs, f: (tester: FragmentShaderTester<Outputs>) => void) {
  webglTest(gl => {
    let tester = new FragmentShaderTester(gl, outputs);
    try {
      f(tester);
    } finally {
      tester.dispose();
    }
  });
}

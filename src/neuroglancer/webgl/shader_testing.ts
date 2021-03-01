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

import {DataType} from 'neuroglancer/util/data_type';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {dataTypeShaderDefinition, getShaderType} from 'neuroglancer/webgl/shader_lib';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {webglTest} from 'neuroglancer/webgl/testing';

export type ShaderIoType = 'int'|'uint'|'float'|'bool'|DataType;

export interface FragmentShaderTestOutputs {
  [key: string]: ShaderIoType;
}

export type ShaderIoJavascriptType<T extends ShaderIoType> = T extends DataType ?
    (T extends DataType.UINT64 ? Uint64 : number) :
    (T extends 'bool' ? boolean : number);

function makeTextureBuffersForOutputs(gl: GL, outputs: FragmentShaderTestOutputs): TextureBuffer[] {
  return Object.keys(outputs).map(key => {
    const t = outputs[key];
    switch (t) {
      case DataType.UINT8:
      case DataType.UINT16:
      case DataType.UINT32:
      case 'bool':
      case 'uint':
        return new TextureBuffer(
            gl, WebGL2RenderingContext.R32UI, WebGL2RenderingContext.RED_INTEGER,
            WebGL2RenderingContext.UNSIGNED_INT);
      case DataType.INT8:
      case DataType.INT16:
      case DataType.INT32:
      case 'int':
        return new TextureBuffer(
            gl, WebGL2RenderingContext.R32I, WebGL2RenderingContext.RED_INTEGER,
            WebGL2RenderingContext.INT);
      case DataType.FLOAT32:
      case 'float':
        return new TextureBuffer(
            gl, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT);
      case DataType.UINT64:
        return new TextureBuffer(
            gl, WebGL2RenderingContext.RG32UI, WebGL2RenderingContext.RG_INTEGER,
            WebGL2RenderingContext.UNSIGNED_INT);
    }
  });
}

function getShaderOutputType(ioType: ShaderIoType): string {
  switch (ioType) {
    case DataType.UINT8:
    case DataType.UINT16:
    case DataType.UINT32:
    case 'uint':
    case 'bool':
      return 'uint';
    case DataType.INT8:
    case DataType.INT16:
    case DataType.INT32:
    case 'int':
      return 'int';
    case DataType.FLOAT32:
    case 'float':
      return 'float';
    case DataType.UINT64:
      return 'uvec2';
  }
}

export class FragmentShaderTester<Inputs extends FragmentShaderTestOutputs, Outputs extends
                                      FragmentShaderTestOutputs> extends RefCounted {
  builder = new ShaderBuilder(this.gl);
  private shader_: ShaderProgram;
  offscreenFramebuffer: FramebufferConfiguration<TextureBuffer>;
  private vertexPositionsBuffer = getSquareCornersBuffer(this.gl, -1, -1, 1, 1);

  constructor(public gl: GL, public inputs: Inputs, public outputs: Outputs) {
    super();
    let {builder} = this;
    this.offscreenFramebuffer = new FramebufferConfiguration(
        this.gl, {colorBuffers: makeTextureBuffersForOutputs(gl, outputs)});
    builder.addAttribute('vec4', 'shader_testing_aVertexPosition');
    builder.setVertexMain(`gl_Position = shader_testing_aVertexPosition;`);
    let beforeMainCode = '';
    let afterMainCode = '';
    for (const [key, t] of Object.entries(inputs)) {
      switch (t) {
        case 'uint':
        case 'int':
        case 'float':
        case DataType.FLOAT32: {
          builder.addUniform(`highp ${getShaderOutputType(t)}`, key);
          break;
        }
        case 'bool': {
          builder.addUniform(`bool`, key);
          break;
        }
        default: {
          builder.addUniform(`highp ${getShaderOutputType(t)}`, `ngin_${key}`);
          builder.addFragmentCode(dataTypeShaderDefinition[t]);
          builder.addFragmentCode(`
${getShaderType(t)} ${key};
`);
          beforeMainCode += `${key}.value = ngin_${key};\n`;
          break;
        }
      }
    }
    Object.keys(outputs).forEach((key, index) => {
      const t = outputs[key];
      switch (t) {
        case 'uint':
        case 'int':
        case 'float':
        case DataType.FLOAT32: {
          builder.addOutputBuffer(`highp ${getShaderOutputType(t)}`, key, index);
          break;
        }
        case 'bool': {
          builder.addOutputBuffer(`highp ${getShaderOutputType(t)}`, `ngout_${key}`, index);
          builder.addFragmentCode(`bool ${key};`);
          afterMainCode += `ngout_${key} = uint(${key});\n`;
          break;
        }
        default: {
          builder.addFragmentCode(dataTypeShaderDefinition[t]);
          builder.addOutputBuffer(`highp ${getShaderOutputType(t)}`, `ngout_${key}`, index);
          builder.addFragmentCode(`${getShaderType(t)} ${key};`);
          afterMainCode += `ngout_${key} = ${key}.value;\n`;
          break;
        }
      }
    });
    builder.addFragmentCode(`
void userMain();
void main() {
  ${beforeMainCode}
  userMain();
  ${afterMainCode}
}
#define main userMain
`);
  }
  get shader() {
    let shader = this.shader_;
    if (shader === undefined) {
      this.build();
    }
    return this.shader_;
  }
  build() {
    this.shader_ = this.builder.build();
    this.shader_!.bind();
  }
  execute(inputValues?: {[P in keyof Inputs]: ShaderIoJavascriptType<Inputs[P]>}) {
    this.offscreenFramebuffer.bind(1, 1);
    const {gl, shader} = this;
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    if (inputValues !== undefined) {
      for (const [key, value] of Object.entries(inputValues)) {
        switch (this.inputs[key]) {
          case DataType.INT8:
          case DataType.INT16:
          case DataType.INT32:
            gl.uniform1i(shader.uniform(`ngin_${key}`), value);
            break;
          case 'int':
          case 'bool':
            gl.uniform1i(shader.uniform(key), value);
            break;
          case DataType.UINT8:
          case DataType.UINT16:
          case DataType.UINT32:
            gl.uniform1ui(shader.uniform(`ngin_${key}`), value);
            break;
          case 'uint':
            gl.uniform1ui(shader.uniform(key), value);
            break;
          case DataType.FLOAT32:
          case 'float':
            gl.uniform1f(shader.uniform(key), value);
            break;
          case DataType.UINT64: {
            let v: Uint64;
            if (typeof value === 'number') {
              v = Uint64.parseString(value.toString());
            } else {
              v = value;
            }
            gl.uniform2ui(shader.uniform(`ngin_${key}`), v.low, v.high);
            break;
          }
        }
      }
    }
    let aVertexPosition = shader.attribute('shader_testing_aVertexPosition');
    this.vertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    gl.disableVertexAttribArray(aVertexPosition);
    this.offscreenFramebuffer.unbind();
  }

  get values(): {[P in keyof Outputs]: ShaderIoJavascriptType<Outputs[P]>} {
    const values = {} as any;
    for (const key of Object.keys(this.outputs)) {
      values[key] = this.read(key);
    }
    return values;
  }

  read(key: keyof Outputs): number|Uint64|boolean {
    const t = this.outputs[key];
    const index = Object.keys(this.outputs).indexOf(key as string);
    const {offscreenFramebuffer} = this;
    const {gl} = this;
    try {
      offscreenFramebuffer.bindSingle(index);
      switch (t) {
        case DataType.UINT8:
        case DataType.UINT16:
        case DataType.UINT32:
        case 'uint':
        case 'bool': {
          const buf = new Uint32Array(4);
          gl.readPixels(
              0, 0, 1, 1, WebGL2RenderingContext.RGBA_INTEGER, WebGL2RenderingContext.UNSIGNED_INT,
            buf);
          return t === 'bool' ? !!buf[0] : buf[0];
        }
        case DataType.INT8:
        case DataType.INT16:
        case DataType.INT32:
        case 'int': {
          const buf = new Int32Array(4);
          gl.readPixels(
              0, 0, 1, 1, WebGL2RenderingContext.RGBA_INTEGER, WebGL2RenderingContext.INT, buf);
          return buf[0];
        }
        case DataType.UINT64: {
          const buf = new Uint32Array(4);
          gl.readPixels(
              0, 0, 1, 1, WebGL2RenderingContext.RGBA_INTEGER, WebGL2RenderingContext.UNSIGNED_INT, buf);
          return new Uint64(buf[0], buf[1]);
        }
        default: {
          const buf = new Float32Array(4);
          gl.readPixels(0, 0, 1, 1, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.FLOAT, buf);
          return buf[0];
        }
      }
    } finally {
      offscreenFramebuffer.unbind();
    }
  }
}

export function fragmentShaderTest<Inputs extends FragmentShaderTestOutputs,
                                                  Outputs extends FragmentShaderTestOutputs>(
    inputs: Inputs, outputs: Outputs, f: (tester: FragmentShaderTester<Inputs, Outputs>) => void) {
  webglTest(gl => {
    let tester = new FragmentShaderTester(gl, inputs, outputs);
    try {
      f(tester);
    } finally {
      tester.dispose();
    }
  });
}

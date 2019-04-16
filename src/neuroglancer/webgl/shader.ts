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
import {GL} from 'neuroglancer/webgl/context';

const DEBUG_SHADER = false;

export enum ShaderType {
  VERTEX = WebGL2RenderingContext.VERTEX_SHADER,
  FRAGMENT = WebGL2RenderingContext.FRAGMENT_SHADER
}

export interface ShaderErrorMessage {
  file?: number;
  line?: number;
  message: string;
}

/**
 * Parses the output of getShaderInfoLog into a list of messages.
 */
export function parseShaderErrors(log: string) {
  log = log.replace('\0', '');
  let result: ShaderErrorMessage[] = [];
  for (let line of log.split('\n')) {
    let m = line.match(/^ERROR:\s*(\d+):(\d+)\s*(.+)$/);
    if (m !== null) {
      result.push({message: m[3].trim(), file: parseInt(m[1], 10), line: parseInt(m[2], 10)});
    } else {
      m = line.match(/^ERROR:\s*(.+)$/);
      if (m !== null) {
        result.push({message: m[1]});
      } else {
        line = line.trim();
        if (line) {
          result.push({message: line});
        }
      }
    }
  }
  return result;
}

export class ShaderCompilationError extends Error {
  shaderType: ShaderType;
  source: string;
  log: string;
  errorMessages: ShaderErrorMessage[];
  constructor(
      shaderType: ShaderType, source: string, log: string, errorMessages: ShaderErrorMessage[]) {
    const message = `Error compiling ${ShaderType[shaderType].toLowerCase()} shader: ${log}`;
    super(message);
    this.name = 'ShaderCompilationError';
    this.log = log;
    this.message = message;
    this.shaderType = shaderType;
    this.source = source;
    this.errorMessages = errorMessages;
  }
}

export class ShaderLinkError extends Error {
  vertexSource: string;
  fragmentSource: string;
  log: string;
  constructor(vertexSource: string, fragmentSource: string, log: string) {
    const message = `Error linking shader: ${log}`;
    super(message);
    this.name = 'ShaderLinkError';
    this.log = log;
    this.message = message;
    this.vertexSource = vertexSource;
    this.fragmentSource = fragmentSource;
  }
}

export function getShader(gl: WebGL2RenderingContext, source: string, shaderType: ShaderType) {
  var shader = gl.createShader(shaderType)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    let log = gl.getShaderInfoLog(shader) || '';

    if (DEBUG_SHADER) {
      let lines = source.replace('<', '&lt;').replace('>', '&gt;').split('\n');
      let s = '<pre>';
      s += log.replace('<', '&lt;').replace('>', '&gt;') + '\n';
      lines.forEach((line, i) => {
        s += `${i + 1}: ${line}\n`;
      });
      s += `\n</pre>`;
      let w = window.open('about:blank', '_blank');
      if (w !== null) {
        try {
          w.document.write(s);
        } catch (writeError) {
        }
      }
    }

    throw new ShaderCompilationError(shaderType, source, log, parseShaderErrors(log));
  }

  return shader!;
}

export type AttributeIndex = number;

export class ShaderProgram extends RefCounted {
  program: WebGLProgram;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  attributes = new Map<string, AttributeIndex>();
  uniforms = new Map<string, WebGLUniformLocation|null>();
  textureUnits: Map<any, number>;

  constructor(
      public gl: GL, public vertexSource: string, public fragmentSource: string,
      uniformNames?: string[], attributeNames?: string[]) {
    super();
    let vertexShader = this.vertexShader = getShader(gl, vertexSource, gl.VERTEX_SHADER);
    let fragmentShader = this.fragmentShader = getShader(gl, fragmentSource, gl.FRAGMENT_SHADER);

    let shaderProgram = gl.createProgram()!;
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      let log = gl.getProgramInfoLog(shaderProgram) || '';

      // DEBUG
      // {
      //   let combinedSource = 'VERTEX SHADER\n\n' + vertexSource + '\n\n\nFRAGMENT SHADER\n\n' +
      //   fragmentSource + '\n';
      //   let w = window.open("about:blank", "_blank");
      //   w.document.write('<pre>' + combinedSource.replace('<', '&lt;').replace('>', '&gt;') +
      //   '</pre>');
      // }

      throw new ShaderLinkError(vertexSource, fragmentSource, log);
    }
    this.program = shaderProgram!;

    let {uniforms, attributes} = this;
    if (uniformNames) {
      for (let name of uniformNames) {
        uniforms.set(name, gl.getUniformLocation(shaderProgram, name));
      }
    }

    if (attributeNames) {
      for (let name of attributeNames) {
        attributes.set(name, gl.getAttribLocation(shaderProgram, name));
      }
    }
  }

  uniform(name: string): WebGLUniformLocation {
    return this.uniforms.get(name)!;
  }

  attribute(name: string): number {
    return this.attributes.get(name)!;
  }

  textureUnit(symbol: Symbol): number {
    return this.textureUnits.get(symbol)!;
  }

  bind() {
    this.gl.useProgram(this.program);
  }

  disposed() {
    let {gl} = this;
    gl.deleteShader(this.vertexShader);
    this.vertexShader = <any>undefined;
    gl.deleteShader(this.fragmentShader);
    this.fragmentShader = <any>undefined;
    gl.deleteProgram(this.program);
    this.program = <any>undefined;
    this.gl = <any>undefined;
    this.attributes = <any>undefined;
    this.uniforms = <any>undefined;
  }
}

export type ShaderCodePart = string|ShaderCodePartArray|ShaderCodePartFunction;
interface ShaderCodePartFunction {
  (): ShaderCodePart;
}
interface ShaderCodePartArray extends Array<ShaderCodePart> {}

export class ShaderCode {
  code = '';
  parts = new Set<ShaderCodePart>();
  constructor() {}

  add(x: ShaderCodePart) {
    if (this.parts.has(x)) {
      return;
    }
    this.parts.add(x);
    switch (typeof x) {
      case 'string':
        this.code += x;
        break;
      case 'function':
        this.add((<ShaderCodePartFunction>x)());
        break;
      default:
        if (Array.isArray(x)) {
          for (let y of x) {
            this.add(y);
          }
        } else {
          console.log('Invalid code type', x);
          throw new Error('Invalid code type');
        }
    }
  }

  toString(): string {
    return this.code;
  }
}

export type ShaderInitializer = ((x: ShaderProgram) => void);
export type ShaderModule = ((x: ShaderBuilder) => void);

export type ShaderSamplerPrefix = 'i' | 'u' | '';

export type ShaderSamplerType =
  'sampler2D'|'usampler2D'|'isampler2D'|'sampler3D'|'usampler3D'|'isampler3D';

export type ShaderInterpolationMode = '' | 'centroid' | 'flat centroid' | 'smooth centroid' | 'flat' | 'smooth';

export const textureTargetForSamplerType = {
  'sampler2D': WebGL2RenderingContext.TEXTURE_2D,
  'isampler2D': WebGL2RenderingContext.TEXTURE_2D,
  'usampler2D': WebGL2RenderingContext.TEXTURE_2D,
  'sampler3D': WebGL2RenderingContext.TEXTURE_3D,
  'isampler3D': WebGL2RenderingContext.TEXTURE_3D,
  'usampler3D': WebGL2RenderingContext.TEXTURE_3D,
};

export class ShaderBuilder {
  private nextSymbolID = 0;
  private nextTextureUnit = 0;
  private uniformsCode = '';
  private attributesCode = '';
  private varyingsCodeVS = '';
  private varyingsCodeFS = '';
  private fragmentExtensionsSet = new Set<string>();
  private fragmentExtensions = '';
  private vertexCode = new ShaderCode();
  private vertexMain = '';
  private fragmentCode = new ShaderCode();
  private outputBufferCode = '';
  private fragmentMain = '';
  private required = new Set<ShaderModule>();
  private uniforms = new Array<string>();
  private attributes = new Array<string>();
  private initializers: Array<ShaderInitializer> = [];
  private textureUnits = new Map<Symbol, number>();
  constructor(public gl: GL) {}

  allocateTextureUnit(symbol: Symbol, count: number = 1) {
    if (this.textureUnits.has(symbol)) {
      throw new Error('Duplicate texture unit symbol: ' + symbol);
    }
    let old = this.nextTextureUnit;
    this.nextTextureUnit += count;
    this.textureUnits.set(symbol, old);
    return old;
  }

  addTextureSampler(samplerType: ShaderSamplerType, name: string, symbol: Symbol, extent?: number) {
    let textureUnit = this.allocateTextureUnit(symbol, extent);
    this.addUniform(`highp ${samplerType}`, name, extent);
    this.addInitializer(shader => {
      if (extent) {
        let textureUnits = new Int32Array(extent);
        for (let i = 0; i < extent; ++i) {
          textureUnits[i] = i + textureUnit;
        }
        shader.gl.uniform1iv(shader.uniform(name), textureUnits);
      } else {
        shader.gl.uniform1i(shader.uniform(name), textureUnit);
      }
    });
    return textureUnit;
  }

  symbol(name: string) {
    return name + (this.nextSymbolID++);
  }

  addAttribute(typeName: string, name: string) {
    this.attributes.push(name);
    this.attributesCode += `in ${typeName} ${name};\n`;
    return name;
  }

  addVarying(typeName: string, name: string, interpolationMode: ShaderInterpolationMode = '') {
    this.varyingsCodeVS += `${interpolationMode} out ${typeName} ${name};\n`;
    this.varyingsCodeFS += `${interpolationMode} in ${typeName} ${name};\n`;
  }

  addOutputBuffer(typeName: string, name: string, location: number|null) {
    if (location !== null) {
      this.outputBufferCode += `layout(location = ${location}) `;
    }
    this.outputBufferCode += `out ${typeName} ${name};\n`;
  }

  addUniform(typeName: string, name: string, extent?: number) {
    this.uniforms.push(name);
    if (extent != null) {
      this.uniformsCode += `uniform ${typeName} ${name}[${extent}];\n`;
    } else {
      this.uniformsCode += `uniform ${typeName} ${name};\n`;
    }
    return name;
  }

  addFragmentExtension(name: string) {
    if (this.fragmentExtensionsSet.has(name)) {
      return;
    }
    this.fragmentExtensionsSet.add(name);
    this.fragmentExtensions += `#extension ${name} : require\n`;
  }

  addVertexCode(code: ShaderCodePart) {
    this.vertexCode.add(code);
  }

  addFragmentCode(code: ShaderCodePart) {
    this.fragmentCode.add(code);
  }

  setVertexMain(code: string) {
    this.vertexMain = code;
  }
  addVertexMain(code: string) {
    this.vertexMain = (this.vertexMain || '') + code;
  }

  setFragmentMain(code: string) {
    this.fragmentMain = `void main() {
${code}
}
`;
  }
  setFragmentMainFunction(code: string) {
    this.fragmentMain = code;
  }

  addInitializer(f: ShaderInitializer) {
    this.initializers.push(f);
  }

  require(f: ShaderModule): void {
    if (this.required.has(f)) {
      return;
    }
    this.required.add(f);
    f(this);
  }

  build() {
    let vertexSource = `#version 300 es
precision highp float;
precision highp int;
${this.uniformsCode}
${this.attributesCode}
${this.varyingsCodeVS}
${this.vertexCode}
void main() {
${this.vertexMain}
}
`;
    let fragmentSource = `#version 300 es
${this.fragmentExtensions}
precision highp float;
precision highp int;
${this.uniformsCode}
${this.varyingsCodeFS}
${this.outputBufferCode}
${this.fragmentCode}
${this.fragmentMain}
`;
    let shader =
        new ShaderProgram(this.gl, vertexSource, fragmentSource, this.uniforms, this.attributes);
    shader.textureUnits = this.textureUnits;
    let {initializers} = this;
    if (initializers.length > 0) {
      shader.bind();
      for (let initializer of initializers) {
        initializer(shader);
      }
    }
    return shader;
  }
}

export function shaderContainsIdentifiers(code: string, identifiers: Iterable<string>) {
  let found = new Set<string>();
  for (let identifier of identifiers) {
    let pattern = new RegExp(`(?:^|[^a-zA-Z0-9_])${identifier}[^a-zA-Z0-9_])`);
    if (code.match(pattern) !== null) {
      found.add(identifier);
    }
  }
  return found;
}

export function dependentShaderGetter(
    refCounted: RefCounted, gl: GL,
    defineShader: (builder: ShaderBuilder) => void): ((emitter: ShaderModule) => ShaderProgram) {
  const shaders = new Map<ShaderModule, ShaderProgram>();
  function getter(emitter: ShaderModule) {
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      const builder = new ShaderBuilder(gl);
      builder.require(emitter);
      defineShader(builder);
      shader = refCounted.registerDisposer(builder.build());
      shaders.set(emitter, shader);
    }
    return shader;
  }
  return getter;
}

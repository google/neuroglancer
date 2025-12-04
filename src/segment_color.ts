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

import { hashCombine } from "#src/gpu_hash/hash_function.js";
import { HashMapUint64, type HashTableBase } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  glsl_hashCombine,
  HashMapShaderManager,
} from "#src/gpu_hash/shader.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import type { PreprocessedSegmentPropertyMap } from "#src/segmentation_display_state/property_map.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  AggregateWatchableValue,
  makeCachedDerivedWatchableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import type { Uint64Map } from "#src/uint64_map.js";
import type { TypedNumberArray } from "#src/util/array.js";
import { hsvToRgb } from "#src/util/colorspace.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { getRandomUint32 } from "#src/util/random.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { glsl_hsvToRgb, glsl_uint64 } from "#src/webgl/shader_lib.js";
import {
  computeTextureFormat,
  getSamplerPrefixForDataType,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

const NUM_COMPONENTS = 2;

export class SegmentColorShaderManager {
  seedName: string;

  constructor(public prefix: string) {
    this.seedName = prefix + "_seed";
  }

  defineShader(builder: ShaderBuilder, fragment = true) {
    const addCode = fragment
      ? builder.addFragmentCode.bind(builder)
      : builder.addVertexCode.bind(builder);
    const { seedName } = this;
    builder.addUniform("highp uint", seedName);
    addCode(glsl_uint64);
    addCode(glsl_hashCombine);
    addCode(glsl_hsvToRgb);
    let s = `
vec3 ${this.prefix}(uint64_t x) {
  uint h = hashCombine(${seedName}, x);
  vec${NUM_COMPONENTS} v;
`;
    for (let i = 0; i < NUM_COMPONENTS; ++i) {
      s += `
  v[${i}] = float(h & 0xFFu) / 255.0;
  h >>= 8u;
`;
    }
    s += `
  vec3 hsv = vec3(v.x, 0.5 + v.y * 0.5, 1.0);
  return hsvToRgb(hsv);
}
`;
    addCode(s);
  }

  enable(gl: GL, shader: ShaderProgram, segmentColorHash: number) {
    gl.uniform1ui(shader.uniform(this.seedName), segmentColorHash);
  }
}

const tempColor = new Float32Array(3);

export function getCssColor(color: Float32Array) {
  return `rgb(${color[0] * 100}%,${color[1] * 100}%,${color[2] * 100}%)`;
}

export class SegmentColorHash implements Trackable {
  changed = new NullarySignal();

  constructor(public hashSeed: number = getRandomUint32()) {}

  static getDefault() {
    return new SegmentColorHash(0);
  }

  get value() {
    return this.hashSeed;
  }

  set value(value: number) {
    if (value !== this.hashSeed) {
      this.hashSeed = value;
      this.changed.dispatch();
    }
  }

  compute(out: Float32Array, x: bigint) {
    let h = hashCombine(this.hashSeed, Number(x & 0xffffffffn));
    h = hashCombine(h, Number(x >> 32n));
    const c0 = (h & 0xff) / 255;
    const c1 = ((h >> 8) & 0xff) / 255;
    hsvToRgb(out, c0, 0.5 + 0.5 * c1, 1.0);
    return out;
  }

  computeCssColor(x: bigint) {
    this.compute(tempColor, x);
    return getCssColor(tempColor);
  }

  randomize() {
    this.hashSeed = getRandomUint32();
    this.changed.dispatch();
  }

  toString() {
    return `new SegmentColorHash(${this.hashSeed})`;
  }

  toJSON() {
    return this.hashSeed === 0 ? undefined : this.hashSeed;
  }

  reset() {
    this.restoreState(0);
  }

  restoreState(x: any) {
    const newSeed = x >>> 0;
    if (newSeed !== this.hashSeed) {
      this.hashSeed = newSeed;
      this.changed.dispatch();
    }
  }
}

/**
 * Adds the shader code to get a segment's color if it is present in the map.
 */
export class SegmentStatedColorShaderManager {
  private hashMapShaderManager = new HashMapShaderManager(
    "segmentStatedColorHash",
  );

  constructor(public prefix: string) {}

  defineShader(builder: ShaderBuilder) {
    this.hashMapShaderManager.defineShader(builder);
    const s = `
bool ${this.getFunctionName}(uint64_t x, out vec4 value) {
  uint64_t uint64Value;
  if (${this.hashMapShaderManager.getFunctionName}(x, uint64Value)) {
    uint uintValue = uint64Value.value[0];
    value.r = float((uintValue & 0x0000ffu))       / 255.0;
    value.g = float((uintValue & 0x00ff00u) >>  8) / 255.0;
    value.b = float((uintValue & 0xff0000u) >> 16) / 255.0;
    value.a = float((uintValue & 0xff000000u) >> 24) / 255.0;
    return true;
  }
  return false;
}
`;
    builder.addFragmentCode(s);
  }

  get getFunctionName() {
    return `${this.prefix}_get`;
  }

  enable<HashTable extends HashTableBase>(
    gl: GL,
    shader: ShaderProgram,
    hashTable: GPUHashTable<HashTable>,
  ) {
    this.hashMapShaderManager.enable(gl, shader, hashTable);
  }

  disable(gl: GL, shader: ShaderProgram) {
    this.hashMapShaderManager.disable(gl, shader);
  }
}

interface SegmentPropertyShaderData {
  accessHelper: OneDimensionalTextureAccessHelper;
  texture: WebGLTexture;
  stale: boolean;
  dataType: DataType;
}

export interface SegmentationColorUserShaderManagerParameters {
  userCode: string;
  hasSegmentDefaultColor: boolean;
  hasSegmentStatedColors: boolean;
}

export class SegmentColorUserShaderManager extends RefCounted {
  // changed = new Signal();

  protected segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );

  protected segmentStatedColorShaderManager =
    new SegmentStatedColorShaderManager("segmentStatedColor");

  private segmentPropertyShaderData = new Map<
    string,
    SegmentPropertyShaderData
  >();

  private userCode = new WatchableValue<string>("");

  manager = new HashMapShaderManager("SegmentToPropertyIndex");
  segmentPropertyIndexMap = new HashMapUint64();

  updateShaderData(
    identifier: string,
    values: TypedNumberArray<ArrayBuffer>,
    dataType: DataType,
  ) {
    if (this.segmentPropertyShaderData.has(identifier)) {
      this.segmentPropertyShaderData.get(identifier)!.stale = false;
    } else {
      this.segmentPropertyShaderData.set(
        identifier,
        createSegmentPropertyShaderData(identifier, values, this.gl, dataType),
      );
    }
  }

  tagToShaderData(
    tag: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ) {
    const { tags } = segmentPropertyMap;
    if (!tags) return;
    const { values } = tags;
    const tagIdx = tags.tags.indexOf(tag);
    if (tagIdx === -1) return; // TODO should we output an error to the user?
    const propertyShaderIdentifier = `tag${tagIdx}`;
    const codeUnit = String.fromCharCode(tagIdx);
    const valuesForTag = values.map((x) => (x.includes(codeUnit) ? 1 : 0));
    this.updateShaderData(
      propertyShaderIdentifier,
      new Uint8Array(valuesForTag),
      DataType.UINT8,
    );
    return propertyShaderIdentifier;
  }

  numericToShaderData(
    identifier: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ) {
    const { numericalProperties } = segmentPropertyMap;
    const propertyIdx = numericalProperties.findIndex(
      (p) => p.id === identifier,
    );
    if (propertyIdx === -1) return; // TODO should we output an error to the user?
    const property = numericalProperties[propertyIdx];
    const propertyShaderIdentifier = `numerical${propertyIdx}`;
    this.updateShaderData(
      propertyShaderIdentifier,
      property.values,
      property.dataType,
    );
    return propertyShaderIdentifier;
  }

  shaderParameters: AggregateWatchableValue<SegmentationColorUserShaderManagerParameters>;

  usedProperties: WatchableValueInterface<Set<string>>;

  get getFunctionName() {
    // TODO do we want this?
    return `segmentColorUserShader`;
  }

  constructor(
    private displayState: SegmentationDisplayState,
    private gl: GL,
  ) {
    super();

    this.shaderParameters = this.registerDisposer(
      new AggregateWatchableValue((refCounted) => ({
        userCode: this.userCode,
        hasSegmentDefaultColor: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (segmentDefaultColor) => {
              return segmentDefaultColor !== undefined;
            },
            [displayState.segmentDefaultColor],
          ),
        ),
        hasSegmentStatedColors: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (segmentStatedColors: Uint64Map) => {
              return segmentStatedColors.size !== 0;
            },
            [displayState.segmentStatedColors],
          ),
        ),
      })),
    );

    // TODO, I can make this lazy if we use this value to trigger defineShader
    this.usedProperties = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        ({ referencedProperties }, segmentPropertyMap, { code }) => {
          console.log("updating usedProperties");
          const tagRegex = /tag\("([^()]+)"\)/g;
          const numericRegex = /prop\("([^()]+)"\)/g;
          const tagNames = new Set(code.matchAll(tagRegex).map((m) => m[1]));
          const numericNames = new Set([
            ...referencedProperties,
            ...code.matchAll(numericRegex).map((m) => m[1]),
          ]);
          for (const [_, data] of this.segmentPropertyShaderData) {
            data.stale = true;
          }
          if (
            segmentPropertyMap &&
            segmentPropertyMap.segmentPropertyMap.inlineProperties
          ) {
            const { segmentPropertyIndexMap } = this;
            if (
              segmentPropertyIndexMap.size === 0 &&
              segmentPropertyMap.numericalProperties.length
            ) {
              // initialize segmentPropertyIndexMap
              const { inlineProperties } =
                segmentPropertyMap.segmentPropertyMap;
              for (let i = 0; i < inlineProperties.ids.length; i++) {
                const id = inlineProperties.ids[i];
                segmentPropertyIndexMap.set(id, BigInt(i));
              }
            }
            if (tagNames.size > 0 || numericNames.size > 0) {
              for (const tag of tagNames) {
                const identifier = this.tagToShaderData(
                  tag,
                  segmentPropertyMap,
                );
                if (identifier) {
                  code = code.replaceAll(
                    `tag("${tag}")`,
                    `${identifier} == 1u`,
                  );
                }
              }
              for (const propName of numericNames) {
                const identifier = this.numericToShaderData(
                  propName,
                  segmentPropertyMap,
                );
                if (identifier) {
                  code = code.replaceAll(`prop("${propName}")`, identifier);
                }
              }
              // if trying to use property values but texture data is not available, disable user shader
              if (this.segmentPropertyShaderData.size === 0) {
                code = "";
              }
            }
          }
          this.userCode.value = code;
          // release unused textures
          for (const [id, { texture, stale }] of this
            .segmentPropertyShaderData) {
            if (stale) {
              gl.deleteTexture(texture);
              this.segmentPropertyShaderData.delete(id);
            }
          }
          // TEMP can we make this more useful?
          return new Set(this.segmentPropertyShaderData.keys());
        },
        [
          this.displayState.segmentColorShaderControlState.builderState,
          this.displayState.segmentationGroupState.value.segmentPropertyMap,
          this.displayState.segmentColorShaderControlState.parseResult,
        ],
      ),
    );

    this.usedProperties.changed.add(() => {
      console.log("this.usedProperties changed", this.usedProperties.value);
    });
  }

  private getMappedIdColor(builder: ShaderBuilder, fragment: boolean) {
    const {
      shaderParameters: { value: shaderParameters },
    } = this;
    const { hasSegmentStatedColors, hasSegmentDefaultColor } = shaderParameters;

    let getMappedIdColor = `vec4 getMappedIdColor(uint64_t value) {
`;
    if (hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
      getMappedIdColor += `
  vec4 rgba;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(value, rgba)) {
    return rgba;
  }
`;
    }
    if (hasSegmentDefaultColor) {
      builder.addUniform("highp vec4", "uSegmentDefaultColor");
      getMappedIdColor += `  return uSegmentDefaultColor;
`;
    } else {
      this.segmentColorShaderManager.defineShader(builder, fragment);
      getMappedIdColor += `  return vec4(segmentColorHash(value), -1.0);
`;
    }
    getMappedIdColor += `
}
`;
    return getMappedIdColor;
  }

  defineShader(builder: ShaderBuilder, fragment: boolean) {
    builder.addUniform("highp float", "uSaturation");
    builder.addUniform("highp uvec2", "uSelectedSegment");
    const addCode = fragment
      ? builder.addFragmentCode.bind(builder)
      : builder.addVertexCode.bind(builder);
    addCode(glsl_COLORMAPS);
    const { manager } = this;
    manager.defineShader(builder, fragment);
    for (const [identifier, { accessHelper, dataType }] of this
      .segmentPropertyShaderData) {
      builder.addTextureSampler(
        `${getSamplerPrefixForDataType(dataType)}sampler2D`,
        `${identifier}_sampler`,
        Symbol.for(identifier),
      );
      accessHelper.defineShader(builder);
      addCode(
        accessHelper.getAccessor(
          `${identifier}_read`,
          `${identifier}_sampler`,
          dataType,
        ),
      );
      addCode(
        `highp ${getShaderOutputType(dataType)} ${identifier};`,
        /*beginning=*/ true,
      );
    }
    const loadSegmentPropertiesCode = `
bool loadSegmentProperties(uint64_t id) {
  uint64_t propertyIndex_64;
  if (!${manager.getFunctionName}(id, propertyIndex_64)) {
    return false;
  }
  uint propertyIndex = propertyIndex_64.value[0];
 ${Array.from(this.segmentPropertyShaderData, ([identifier, { dataType }]) => {
   return `
  ${identifier} = ${identifier}_read(propertyIndex)${dataType === DataType.FLOAT32 ? "" : ".value"};
`;
 }).join("\n")}
  return true;
}`;
    addCode(this.getMappedIdColor(builder, fragment));
    addCode(loadSegmentPropertiesCode);
    addCode(this.userCode.value);
    addCode(`
vec4 segmentColorUserShader(uint64_t segmentId, float adjustment) {
  float alpha = -1.0; // negative means use original alpha
  vec4 color = getMappedIdColor(segmentId);
  float saturation = uSaturation;
  if (uSelectedSegment == segmentId.value) {
    if (saturation > adjustment) {
      saturation -= adjustment;
    } else {
      saturation += adjustment;
    }
  }
${
  this.userCode.value
    ? `
  bool hasProperties = loadSegmentProperties(segmentId);
  color = segmentColor(color, hasProperties);
  if (color.a >= 0.0) {
    alpha = color.a;
  }
`
    : ""
}
  return vec4(mix(vec3(1.0,1.0,1.0), vec3(color), saturation), alpha);
}`);
    addCode(`
  vec4 segmentColorUserShader(uint64_t segmentId) {
    return segmentColorUserShader(segmentId, 0.5);
  }
`);
  }

  enable(gl: GL, shader: ShaderProgram) {
    {
      const { displayState } = this;
      let selectedSegmentLow = 0;
      let selectedSegmentHigh = 0;
      const { segmentSelectionState } = this.displayState;
      if (
        segmentSelectionState.hasSelectedSegment &&
        displayState.hoverHighlight.value
      ) {
        const seg = displayState.baseSegmentHighlighting.value
          ? segmentSelectionState.baseSelectedSegment
          : segmentSelectionState.selectedSegment;
        selectedSegmentLow = Number(seg & 0xffffffffn);
        selectedSegmentHigh = Number(seg >> 32n);
      }
      gl.uniform1f(
        shader.uniform("uSaturation"),
        displayState.saturation.value,
      );
      gl.uniform2ui(
        shader.uniform("uSelectedSegment"),
        selectedSegmentLow,
        selectedSegmentHigh,
      );

      const { hasSegmentDefaultColor } = this.shaderParameters.value;
      if (hasSegmentDefaultColor) {
        const {
          segmentDefaultColor: { value: segmentDefaultColor },
        } = displayState;
        if (segmentDefaultColor) {
          const [r, g, b] = segmentDefaultColor;
          gl.uniform4f(shader.uniform("uSegmentDefaultColor"), r, g, b, -1.0);
          // TODO, override with displayState.tempSegmentDefaultColor2d.value in segemntation_renderlayer
        }
      } else {
        const {
          segmentColorHash: { value: segmentColorHash },
        } = displayState;
        this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
      }
    }

    this.manager.enable(
      gl,
      shader,
      GPUHashTable.get(this.gl, this.segmentPropertyIndexMap),
    );
    for (const [identifier, { texture }] of this.segmentPropertyShaderData) {
      const textureUnit = shader.textureUnit(Symbol.for(identifier));
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    }
  }
}

function createSegmentPropertyShaderData(
  identifier: string,
  values: TypedNumberArray<ArrayBuffer>,
  gl: GL,
  dataType: DataType,
) {
  const texture = gl.createTexture();
  // for now, immediately load the data into the texture
  {
    const textureFormat = computeTextureFormat(
      new TextureFormat(),
      dataType,
      1,
    );
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + gl.tempTextureUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    setOneDimensionalTextureData(gl, textureFormat, values);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  }

  return {
    accessHelper: new OneDimensionalTextureAccessHelper(
      `segmentproperty_${identifier}`,
    ),
    texture,
    stale: false,
    dataType,
  } satisfies SegmentPropertyShaderData;
}

function getShaderOutputType(ioType: DataType): string {
  switch (ioType) {
    case DataType.UINT8:
    case DataType.UINT16:
    case DataType.UINT32:
      return "uint";
    case DataType.INT8:
    case DataType.INT16:
    case DataType.INT32:
      return "int";
    case DataType.FLOAT32:
      return "float";
    case DataType.UINT64:
      return "uint64_t";
  }
}

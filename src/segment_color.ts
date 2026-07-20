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
  makeCachedLazyDerivedWatchableValue,
} from "#src/trackable_value.js";
import type { Uint64Map } from "#src/uint64_map.js";
import type { TypedNumberArray } from "#src/util/array.js";
import { hsvToRgb } from "#src/util/colorspace.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3, vec4 } from "#src/util/geom.js";
import { getRandomUint32 } from "#src/util/random.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { GL } from "#src/webgl/context.js";
import { shaderCodeWithLineDirective } from "#src/webgl/dynamic_shader.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import {
  glsl_hsvToRgb,
  glsl_string,
  glsl_uint64,
} from "#src/webgl/shader_lib.js";
import type { ShaderStringLiteralIdMap } from "#src/webgl/shader_source_string_preprocessing.js";
import type {
  SegmentPropertyReference,
  ShaderControlsBuilderState,
} from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  setControlsInShader,
} from "#src/webgl/shader_ui_controls.js";
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

  defineShader(builder: ShaderBuilder, fragment = true) {
    const addCode = fragment
      ? builder.addFragmentCode.bind(builder)
      : builder.addVertexCode.bind(builder);
    this.hashMapShaderManager.defineShader(builder, fragment);
    const s = `
bool ${this.getFunctionName}(uint64_t x, out vec4 value) {
  uint64_t uint64Value;
  if (${this.hashMapShaderManager.getFunctionName}(x, uint64Value)) {
    uint uintValue = uint64Value.value[0];
    uint alpha = (uintValue & 0xff000000u) >> 24;
    value.r = float((uintValue & 0x0000ffu))       / 255.0;
    value.g = float((uintValue & 0x00ff00u) >>  8) / 255.0;
    value.b = float((uintValue & 0xff0000u) >> 16) / 255.0;
    value.a = alpha == 0u ? -1.0 : float(alpha) / 255.0;
    return true;
  }
  return false;
}
`;
    addCode(s);
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
  texture: WebGLTexture;
  dataType: DataType;
  sourceValues: unknown;
  stringLiteralIds: ShaderStringLiteralIdMap | undefined;
}

export interface SegmentPropertyShaderDefinition {
  identifier: string;
  dataType: DataType;
}

export function encodeSegmentPropertyShaderDefinition(
  definition: SegmentPropertyShaderDefinition,
) {
  return `${definition.identifier}:${definition.dataType}`;
}

interface SegmentPropertyReferencesResult {
  segmentProperties: SegmentPropertyReference[];
  allPropertiesFound: boolean;
  errors: SegmentPropertyReferenceError[];
}

interface SegmentPropertyReferenceError {
  line: number;
  message: string;
}

const segmentPropertyHelperCallPattern =
  /\b(tag|prop)\s*\(\s*string_t\(\s*(\d+)u\s*\)\s*\)/g;

function getLineNumberAtIndex(code: string, index: number) {
  return Math.max(0, code.substring(0, index).split("\n").length - 1);
}

export interface SegmentationColorUserShaderManagerParameters {
  hasSegmentDefaultColor: boolean;
  hasSegmentStatedColors: boolean;
}

export interface SegmentationColorUserShaderManagerInputs {
  segmentDefaultColor: vec3 | vec4 | undefined;
  segmentStatedColors: Uint64Map;
  hoverHighlight: boolean;
}

export class SegmentColorUserShaderManager extends RefCounted {
  protected segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  protected hashMapManager = new HashMapShaderManager("SegmentToPropertyIndex");
  protected segmentStatedColorShaderManager =
    new SegmentStatedColorShaderManager("segmentStatedColor");

  private gpuSegmentStatedColorHashTable:
    | GPUHashTable<HashMapUint64>
    | undefined;

  public shaderParameters: AggregateWatchableValue<SegmentationColorUserShaderManagerParameters>;
  public usedProperties: WatchableValueInterface<
    readonly SegmentPropertyShaderDefinition[]
  >;

  private segmentPropertyIndexMap = new HashMapUint64();
  private segmentPropertyIndexMapSource:
    | PreprocessedSegmentPropertyMap
    | undefined;
  private segmentPropertyShaderData = new Map<
    string,
    SegmentPropertyShaderData
  >();

  constructor(
    private displayState: SegmentationDisplayState,
    private gl: GL,
  ) {
    super();
    this.shaderParameters = this.registerDisposer(
      new AggregateWatchableValue((refCounted) => ({
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

    this.usedProperties = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (builderState, segmentPropertyMap) => {
          const { segmentProperties } = this.getSegmentPropertyReferences(
            builderState,
            segmentPropertyMap,
          );
          const { definitions } = this.getSegmentPropertyShaderDefinitions(
            segmentProperties,
            segmentPropertyMap,
          );
          return definitions;
        },
        this.displayState.segmentColorShaderControlState.builderState,
        this.displayState.segmentationGroupState.value.segmentPropertyMap,
      ),
    );
  }

  private getSegmentPropertyMap() {
    return this.displayState.segmentationGroupState.value.segmentPropertyMap
      .value;
  }

  private getDefaultInputs(): SegmentationColorUserShaderManagerInputs {
    return {
      segmentDefaultColor: this.displayState.segmentDefaultColor.value,
      segmentStatedColors: this.displayState.segmentStatedColors.value,
      hoverHighlight: this.displayState.hoverHighlight.value,
    };
  }

  private getSegmentPropertyShaderDefinition(
    prop: SegmentPropertyReference,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ): SegmentPropertyShaderDefinition | undefined {
    if (prop.type === "tag") {
      const { tags } = segmentPropertyMap;
      if (!tags) return undefined;
      const index = tags.tags.indexOf(prop.id);
      return index === -1
        ? undefined
        : { identifier: `tag${index}`, dataType: DataType.UINT8 };
    }
    if (prop.type === "numerical") {
      const index = segmentPropertyMap.numericalProperties.findIndex(
        (p) => p.id === prop.id,
      );
      if (index === -1) return undefined;
      return {
        identifier: `numerical${index}`,
        dataType: segmentPropertyMap.numericalProperties[index].dataType,
      };
    }
    const index = segmentPropertyMap.strings.findIndex((p) => p.id === prop.id);
    return index === -1
      ? undefined
      : { identifier: `string${index}`, dataType: DataType.UINT8 };
  }

  private getSegmentPropertyReferenceForHelperCall(
    helperName: string,
    id: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ): SegmentPropertyReference | undefined {
    if (helperName === "tag") {
      return segmentPropertyMap.tags?.tags.includes(id)
        ? { type: "tag", id }
        : undefined;
    }
    if (segmentPropertyMap.numericalProperties.some((p) => p.id === id)) {
      return { type: "numerical", id };
    }
    if (segmentPropertyMap.strings.some((p) => p.id === id)) {
      return { type: "string", id };
    }
    return undefined;
  }

  private getSegmentPropertyReferences(
    builderState: ShaderControlsBuilderState,
    segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
  ): SegmentPropertyReferencesResult {
    const segmentProperties = [...builderState.segmentProperties];
    const errors: SegmentPropertyReferenceError[] = [];
    let allPropertiesFound = true;
    const stringLiteralValues = new Map(
      [...builderState.parseResult.preprocessing.stringLiteralIds].map(
        ([value, id]) => [id, value],
      ),
    );
    const addReference = (reference: SegmentPropertyReference) => {
      if (
        !segmentProperties.some(
          (x) => x.type === reference.type && x.id === reference.id,
        )
      ) {
        segmentProperties.push(reference);
      }
    };
    for (const match of builderState.parseResult.code.matchAll(
      segmentPropertyHelperCallPattern,
    )) {
      const helperName = match[1];
      const line = getLineNumberAtIndex(
        builderState.parseResult.code,
        match.index ?? 0,
      );
      const propertyId = stringLiteralValues.get(Number(match[2]));
      if (propertyId === undefined) {
        errors.push({
          line,
          message: `'${helperName}(unknown)' : property string literal does not exist`,
        });
        continue;
      }
      if (segmentPropertyMap === undefined) {
        allPropertiesFound = false;
        continue;
      }
      const reference = this.getSegmentPropertyReferenceForHelperCall(
        helperName,
        propertyId,
        segmentPropertyMap,
      );
      if (reference === undefined) {
        errors.push({
          line,
          message:
            helperName === "tag"
              ? `'tag(${JSON.stringify(propertyId)})' : tag does not exist`
              : `'prop(${JSON.stringify(propertyId)})' : property does not exist`,
        });
        continue;
      }
      addReference(reference);
    }
    return { segmentProperties, allPropertiesFound, errors };
  }

  private rewriteSegmentPropertyHelperCalls(
    code: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
    stringLiteralIds: ShaderStringLiteralIdMap,
  ) {
    const stringLiteralValues = new Map(
      [...stringLiteralIds].map(([value, id]) => [id, value]),
    );
    return code.replace(
      segmentPropertyHelperCallPattern,
      (match, helperName: string, literalId: string) => {
        const propertyId = stringLiteralValues.get(Number(literalId));
        if (propertyId === undefined) return match;
        const reference = this.getSegmentPropertyReferenceForHelperCall(
          helperName,
          propertyId,
          segmentPropertyMap,
        );
        if (reference === undefined) return match;
        const definition = this.getSegmentPropertyShaderDefinition(
          reference,
          segmentPropertyMap,
        );
        if (definition === undefined) return match;
        switch (reference.type) {
          case "tag":
            return `(${definition.identifier} == 1u)`;
          case "string":
            return `string_t(${definition.identifier})`;
          case "numerical":
            return definition.identifier;
        }
      },
    );
  }

  private getSegmentPropertyShaderDefinitions(
    segmentProperties: SegmentPropertyReference[],
    segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
  ) {
    const definitions = new Map<string, SegmentPropertyShaderDefinition>();
    let allPropertiesFound = true;
    if (segmentProperties.length !== 0 && segmentPropertyMap === undefined) {
      allPropertiesFound = false;
    }
    if (segmentPropertyMap !== undefined) {
      for (const prop of segmentProperties) {
        const definition = this.getSegmentPropertyShaderDefinition(
          prop,
          segmentPropertyMap,
        );
        if (definition === undefined) {
          allPropertiesFound = false;
          continue;
        }
        definitions.set(definition.identifier, definition);
      }
    }
    return { definitions: [...definitions.values()], allPropertiesFound };
  }

  private updateSegmentPropertyIndexMap(
    segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
  ) {
    if (this.segmentPropertyIndexMapSource === segmentPropertyMap) return;
    this.segmentPropertyIndexMap.clear();
    this.segmentPropertyIndexMapSource = segmentPropertyMap;
    const inlineProperties =
      segmentPropertyMap?.segmentPropertyMap.inlineProperties;
    if (inlineProperties === undefined) return;
    for (let i = 0; i < inlineProperties.ids.length; i++) {
      this.segmentPropertyIndexMap.set(inlineProperties.ids[i], BigInt(i));
    }
  }

  private deleteSegmentPropertyTexture(identifier: string) {
    const data = this.segmentPropertyShaderData.get(identifier);
    if (data === undefined) return;
    this.gl.deleteTexture(data.texture);
    this.segmentPropertyShaderData.delete(identifier);
  }

  private updateShaderData(
    identifier: string,
    values: TypedNumberArray<ArrayBuffer>,
    dataType: DataType,
    sourceValues: unknown = values,
    stringLiteralIds?: ShaderStringLiteralIdMap,
  ) {
    const existing = this.segmentPropertyShaderData.get(identifier);
    if (
      existing !== undefined &&
      existing.dataType === dataType &&
      existing.sourceValues === sourceValues &&
      existing.stringLiteralIds === stringLiteralIds
    ) {
      return;
    }
    this.deleteSegmentPropertyTexture(identifier);
    this.segmentPropertyShaderData.set(identifier, {
      ...createSegmentPropertyTextureData(values, this.gl, dataType),
      sourceValues,
      stringLiteralIds,
    });
  }

  private tagPropertyToShaderData(
    id: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ) {
    const { tags } = segmentPropertyMap;
    if (!tags) return;
    const index = tags.tags.indexOf(id);
    if (index === -1) return;
    const { values } = tags;
    const propertyShaderIdentifier = `tag${index}`;
    const codeUnit = String.fromCharCode(index);
    const valuesForTag = values.map((x) => (x.includes(codeUnit) ? 1 : 0));
    this.updateShaderData(
      propertyShaderIdentifier,
      new Uint8Array(valuesForTag),
      DataType.UINT8,
      values,
    );
    return propertyShaderIdentifier;
  }

  private numericPropertyToShaderData(
    id: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
  ) {
    const { numericalProperties } = segmentPropertyMap;
    const index = numericalProperties.findIndex((p) => p.id === id);
    if (index === -1) return;
    const property = numericalProperties[index];
    const propertyShaderIdentifier = `numerical${index}`;
    this.updateShaderData(
      propertyShaderIdentifier,
      property.values,
      property.dataType,
    );
    return propertyShaderIdentifier;
  }

  private stringPropertyToShaderData(
    id: string,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
    stringLiteralIds: ShaderStringLiteralIdMap,
  ) {
    const { strings } = segmentPropertyMap;
    const index = strings.findIndex((p) => p.id === id);
    if (index === -1) return;
    const property = strings[index];
    const propertyShaderIdentifier = `string${index}`;
    this.updateShaderData(
      propertyShaderIdentifier,
      new Uint8Array(property.values.map((x) => stringLiteralIds.get(x) ?? 0)),
      DataType.UINT8,
      property.values,
      stringLiteralIds,
    );
    return propertyShaderIdentifier;
  }

  private updateSegmentPropertyTexture(
    prop: SegmentPropertyReference,
    segmentPropertyMap: PreprocessedSegmentPropertyMap,
    stringLiteralIds: ShaderStringLiteralIdMap,
  ) {
    switch (prop.type) {
      case "tag":
        return this.tagPropertyToShaderData(prop.id, segmentPropertyMap);
      case "numerical":
        return this.numericPropertyToShaderData(prop.id, segmentPropertyMap);
      case "string":
        return this.stringPropertyToShaderData(
          prop.id,
          segmentPropertyMap,
          stringLiteralIds,
        );
    }
  }

  private updateSegmentPropertyTextures(
    builderState: ShaderControlsBuilderState,
  ) {
    const activeIdentifiers = new Set<string>();
    const { parseResult } = builderState;
    const segmentPropertyMap = this.getSegmentPropertyMap();
    const { segmentProperties } = this.getSegmentPropertyReferences(
      builderState,
      segmentPropertyMap,
    );
    this.updateSegmentPropertyIndexMap(segmentPropertyMap);
    if (segmentPropertyMap !== undefined) {
      const {
        preprocessing: { stringLiteralIds },
      } = parseResult;
      for (const prop of segmentProperties) {
        const identifier = this.updateSegmentPropertyTexture(
          prop,
          segmentPropertyMap,
          stringLiteralIds,
        );
        if (typeof identifier === "string") {
          activeIdentifiers.add(identifier);
        }
      }
    }
    for (const identifier of this.segmentPropertyShaderData.keys()) {
      if (!activeIdentifiers.has(identifier)) {
        this.deleteSegmentPropertyTexture(identifier);
      }
    }
    return activeIdentifiers;
  }

  private getMappedIdColor(
    builder: ShaderBuilder,
    fragment: boolean,
    shaderParameters: SegmentationColorUserShaderManagerParameters,
  ) {
    const { hasSegmentStatedColors, hasSegmentDefaultColor } = shaderParameters;
    let getMappedIdColor = `vec4 getMappedIdColor(uint64_t value, out bool isStated) {
`;
    if (hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder, fragment);
      getMappedIdColor += `
  vec4 rgba;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(value, rgba)) {
    isStated = true;
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

  defineShader(
    builder: ShaderBuilder,
    fragment: boolean,
    builderState: ShaderControlsBuilderState = this.displayState
      .segmentColorShaderControlState.builderState.value,
    shaderParameters: SegmentationColorUserShaderManagerParameters = this
      .shaderParameters.value,
  ) {
    builder.addUniform("highp float", "uSaturation");
    builder.addUniform("bool", "uHasSelectedSegment");
    builder.addUniform("highp uvec2", "uSelectedSegment");
    const addCode = fragment
      ? builder.addFragmentCode.bind(builder)
      : builder.addVertexCode.bind(builder);
    const { hashMapManager } = this;
    hashMapManager.defineShader(builder, fragment);
    addCode(this.getMappedIdColor(builder, fragment, shaderParameters));
    const { parseResult } = builderState;
    const segmentPropertyMap = this.getSegmentPropertyMap();
    const {
      segmentProperties,
      allPropertiesFound: allReferencedPropertiesFound,
      errors,
    } = this.getSegmentPropertyReferences(builderState, segmentPropertyMap);
    const { definitions, allPropertiesFound } =
      this.getSegmentPropertyShaderDefinitions(
        segmentProperties,
        segmentPropertyMap,
      );
    let userCode =
      allReferencedPropertiesFound && allPropertiesFound
        ? parseResult.code
        : "";
    if (errors.length !== 0 && segmentPropertyMap !== undefined) {
      userCode = `${errors
        .map(({ line, message }) => `#line ${line} 1\n#error ${message}\n`)
        .join("")}
bool tag(string_t value) {
  return false;
}
highp uint prop(string_t value) {
  return 0u;
}
#line 0 1
${parseResult.code}`;
    }
    if (userCode && segmentPropertyMap !== undefined) {
      userCode = this.rewriteSegmentPropertyHelperCalls(
        userCode,
        segmentPropertyMap,
        parseResult.preprocessing.stringLiteralIds,
      );
    }
    if (userCode) {
      addCode(glsl_COLORMAPS);
      if (parseResult.preprocessing.stringLiteralIds.size !== 0) {
        addCode(glsl_string);
      }
      for (const { identifier, dataType } of definitions) {
        const accessHelper = new OneDimensionalTextureAccessHelper(
          `segmentproperty_${identifier}`,
        );
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
        addCode(`highp ${getShaderOutputType(dataType)} ${identifier};\n`);
      }
      addControlsToBuilder(builderState, builder, fragment);
      const loadSegmentPropertiesCode = `
bool loadSegmentProperties(uint64_t id) {
  uint64_t propertyIndex_64;
  if (!${hashMapManager.getFunctionName}(id, propertyIndex_64)) {
    return false;
  }
  uint propertyIndex = propertyIndex_64.value[0];
 ${definitions
   .map(({ identifier, dataType }) => {
     return `
  ${identifier} = ${identifier}_read(propertyIndex)${dataType === DataType.FLOAT32 ? "" : ".value"};
`;
   })
   .join("\n")}
  return true;
}`;
      addCode(loadSegmentPropertiesCode);
      addCode(shaderCodeWithLineDirective(userCode));
      if (userCode.includes("vec3 segmentColor(")) {
        addCode(`
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  return vec4(segmentColor(color.rgb, hasProperties, isStated), color.a);
}`);
      }
    }
    addCode(`
vec4 segmentColorUserShader(uint64_t segmentId, float adjustment) {
  float alpha = -1.0; // negative = undefined
  bool isStated = false;
  vec4 color = getMappedIdColor(segmentId, isStated);
  alpha = color.a;
  float saturation = uSaturation;
  if (uHasSelectedSegment && uSelectedSegment == segmentId.value) {
    if (saturation > adjustment) {
      saturation -= adjustment;
    } else {
      saturation += adjustment;
    }
  }
${
  userCode
    ? `
  bool hasProperties = loadSegmentProperties(segmentId);
  color = segmentColor(color, hasProperties, isStated);
`
    : ""
}
  return vec4(mix(vec3(1.0,1.0,1.0), vec3(color), saturation), color.a);
}
vec4 segmentColorUserShader(uint64_t segmentId) {
  return segmentColorUserShader(segmentId, 0.5);
}
`);
  }

  enable(
    gl: GL,
    shader: ShaderProgram,
    builderState: ShaderControlsBuilderState,
    shaderParameters: SegmentationColorUserShaderManagerParameters = this
      .shaderParameters.value,
    inputs: SegmentationColorUserShaderManagerInputs = this.getDefaultInputs(),
  ) {
    const { parseResult } = builderState;
    const { displayState } = this;
    let selectedSegmentLow = 0;
    let selectedSegmentHigh = 0;
    const { segmentSelectionState } = this.displayState;
    const hasSelectedSegment =
      segmentSelectionState.hasSelectedSegment && inputs.hoverHighlight;
    gl.uniform1ui(
      shader.uniform("uHasSelectedSegment"),
      hasSelectedSegment ? 1 : 0,
    );
    if (hasSelectedSegment) {
      const seg = displayState.baseSegmentHighlighting.value
        ? segmentSelectionState.baseSelectedSegment
        : segmentSelectionState.selectedSegment;
      selectedSegmentLow = Number(seg & 0xffffffffn);
      selectedSegmentHigh = Number(seg >> 32n);
      // only update when we have a selected segment since we ignore when uHasSelectedSegment is false
      gl.uniform2ui(
        shader.uniform("uSelectedSegment"),
        selectedSegmentLow,
        selectedSegmentHigh,
      );
    }
    gl.uniform1f(shader.uniform("uSaturation"), displayState.saturation.value);
    const { hasSegmentDefaultColor, hasSegmentStatedColors } = shaderParameters;
    if (hasSegmentDefaultColor) {
      const { segmentDefaultColor } = inputs;
      if (segmentDefaultColor) {
        const [r, g, b, a] = segmentDefaultColor;
        gl.uniform4f(
          shader.uniform("uSegmentDefaultColor"),
          r,
          g,
          b,
          a === undefined ? -1.0 : a,
        );
      }
    } else {
      const {
        segmentColorHash: { value: segmentColorHash },
      } = displayState;
      this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    }
    setControlsInShader(
      gl,
      shader,
      this.displayState.segmentColorShaderControlState,
      parseResult,
    );
    const activeSegmentPropertyIdentifiers =
      this.updateSegmentPropertyTextures(builderState);
    this.hashMapManager.enable(
      gl,
      shader,
      GPUHashTable.get(this.gl, this.segmentPropertyIndexMap),
    );
    for (const identifier of activeSegmentPropertyIdentifiers) {
      const { texture } = this.segmentPropertyShaderData.get(identifier)!;
      const textureUnit = shader.textureUnit(Symbol.for(identifier));
      if (textureUnit !== undefined) {
        gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
        gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      }
    }
    if (hasSegmentStatedColors) {
      const { segmentStatedColors } = inputs;
      let { gpuSegmentStatedColorHashTable } = this;
      if (
        gpuSegmentStatedColorHashTable === undefined ||
        gpuSegmentStatedColorHashTable.hashTable !==
          segmentStatedColors.hashTable
      ) {
        gpuSegmentStatedColorHashTable?.dispose();
        this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
          GPUHashTable.get(gl, segmentStatedColors.hashTable);
      }
      this.segmentStatedColorShaderManager.enable(
        gl,
        shader,
        gpuSegmentStatedColorHashTable,
      );
    }
  }

  disable(
    gl: GL,
    shader: ShaderProgram,
    shaderParameters: SegmentationColorUserShaderManagerParameters = this
      .shaderParameters.value,
  ) {
    this.hashMapManager.disable(gl, shader);
    const { hasSegmentStatedColors } = shaderParameters;
    if (hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.disable(gl, shader);
    }
  }

  disposed() {
    for (const { texture } of this.segmentPropertyShaderData.values()) {
      this.gl.deleteTexture(texture);
    }
    this.segmentPropertyShaderData.clear();
    this.gpuSegmentStatedColorHashTable?.dispose();
  }
}

function createSegmentPropertyTextureData(
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
    texture,
    dataType,
  };
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

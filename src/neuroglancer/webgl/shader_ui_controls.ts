/**
 * @license
 * Copyright 2019 Google Inc.
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

import {CoordinateSpaceCombiner} from 'neuroglancer/coordinate_transform';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {constantWatchableValue, makeCachedDerivedWatchableValue, makeCachedLazyDerivedWatchableValue, TrackableValue, TrackableValueInterface, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual, arraysEqualWithPredicate} from 'neuroglancer/util/array';
import {parseRGBColorSpecification, TrackableRGB} from 'neuroglancer/util/color';
import {DataType} from 'neuroglancer/util/data_type';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFiniteFloat, verifyInt, verifyObject, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {convertDataTypeInterval, DataTypeInterval, dataTypeIntervalToJson, defaultDataTypeRange, normalizeDataTypeInterval, parseDataTypeInterval, parseUnknownDataTypeInterval, validateDataTypeInterval} from 'neuroglancer/util/lerp';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {GL} from 'neuroglancer/webgl/context';
import {HistogramChannelSpecification, HistogramSpecifications} from 'neuroglancer/webgl/empirical_cdf';
import {defineInvlerpShaderFunction, enableLerpShaderFunction} from 'neuroglancer/webgl/lerp';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export interface ShaderSliderControl {
  type: 'slider';
  valueType: 'int'|'uint'|'float';
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface ShaderColorControl {
  type: 'color';
  valueType: 'vec3';
  defaultString: string;
  default: vec3;
}

export interface ShaderImageInvlerpControl {
  type: 'imageInvlerp';
  dataType: DataType;
  clamp: boolean;
  default: ImageInvlerpParameters;
}

export type PropertiesSpecification = Map<string, DataType>;

export interface ShaderPropertyInvlerpControl {
  type: 'propertyInvlerp';
  clamp: boolean;
  properties: PropertiesSpecification;
  default: PropertyInvlerpParameters;
}

export interface ShaderCheckboxControl {
  type: 'checkbox';
  valueType: 'bool';
  default: boolean;
}

export type ShaderUiControl =
    ShaderSliderControl|ShaderColorControl|ShaderImageInvlerpControl|ShaderPropertyInvlerpControl|ShaderCheckboxControl;

export interface ShaderControlParseError {
  line: number;
  message: string;
}

export interface ShaderControlsParseResult {
  // Original source code entered by user.
  source: string;
  // Source code with comments stripped and UI controls replaced by appropriate text.
  code: string;
  controls: Map<string, ShaderUiControl>;
  errors: ShaderControlParseError[];
}

export interface ShaderControlsBuilderState {
  key: string;
  parseResult: ShaderControlsParseResult;
  builderValues: ShaderBuilderValues;
  referencedProperties: string[];
}

// Strips comments from GLSL code.  Also handles string literals since they are used in ui control
// directives.
export function stripComments(code: string) {
  // https://stackoverflow.com/a/241506
  const commentPattern = /\/\/.*?$|\/\*(?:.|\n)*?\*\/|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"/mg;
  return code.replace(commentPattern, m => {
    if (m.startsWith('/')) {
      return m.replace(/[^\s]/g, ' ');
    }
    return m;
  });
}

type DirectiveParameters = Map<string, any>;

// Returns the length of the prefix that may be a valid directive parameter.
function matchDirectiveParameterValue(input: string): number {
  const valueTokenPattern =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:\\.|[^\\"])*"|true|false|:|\s+|,|\[|\]|\{|\})/;
  let depth = 0;
  let initialInput = input;
  outerLoop: while (input.length) {
    const m = input.match(valueTokenPattern);
    if (m === null) break;
    const token = m[0];
    switch (token.charAt(0)) {
      case '[':
      case '{':
        ++depth;
        break;
      case ']':
      case '}':
        if (--depth < 0) return -1;
        break;
      case ',':
        if (depth === 0) break outerLoop;
        break;
      default:
        if (depth === 0) {
          input = input.substring(token.length);
          break outerLoop;
        }
        break;
    }
    input = input.substring(token.length);
  }
  if (depth !== 0) return -1;
  return initialInput.length - input.length;
}

export function parseDirectiveParameters(input: string|undefined):
    {parameters: DirectiveParameters, errors: string[]} {
  let errors: string[] = [];
  let parameters = new Map<string, number|string>();
  if (input === undefined) {
    return {errors, parameters};
  }
  const startPattern = /^([_a-z][_a-zA-Z0-9]*)[ \t]*=/;
  while (true) {
    input = input.trim();
    if (input.length == 0) break;
    const m = input.match(startPattern);
    if (m === null) {
      errors.push('Invalid #uicontrol parameter syntax, expected: <param>=<value>, ...');
      break;
    }
    const name = m[1];
    input = input.substring(m[0].length);
    let valueLength = matchDirectiveParameterValue(input);
    if (valueLength <= 0) {
      errors.push('Invalid #uicontrol parameter syntax, expected: <param>=<value>, ...');
      break;
    }
    let value;
    try {
      value = JSON.parse(input.substring(0, valueLength));
    } catch {
      errors.push(`Invalid #uicontrol parameter value for ${name}: ${value}`);
      break;
    }
    if (parameters.has(name)) {
      errors.push(`Duplicate #uicontrol parameter: ${name}`);
    } else {
      parameters.set(name, value);
    }
    input = input.substring(valueLength);
    input = input.trim();
    if (input.length > 0 && !input.startsWith(',')) {
      errors.push('Invalid #uicontrol parameter syntax, expected: <param>=<value>, ...');
    }
    input = input.substring(1);
  }
  return {parameters, errors};
}

type DirectiveParseResult = {
  control: ShaderUiControl,
  errors: undefined
}|{errors: string[]};

function parseSliderDirective(
    valueType: string, parameters: DirectiveParameters): DirectiveParseResult {
  let min: number|undefined;
  let max: number|undefined;
  let step: number|undefined;
  let defaultValue: number|undefined;
  let errors = [];
  if (valueType !== 'float' && valueType !== 'uint' && valueType !== 'int') {
    errors.push('type must be float, int, or uint');
  }
  for (const [key, value] of parameters) {
    const getValue = (): number|undefined => {
      if (typeof value !== 'number') {
        errors.push(`Expected ${key} argument to be a number`);
        return undefined;
      }
      if (valueType === 'int' || valueType === 'uint') {
        if (!Number.isInteger(value)) {
          errors.push(`Expected ${key} argument to be an integer`);
        }
        if (valueType === 'uint' && value < 0) {
          errors.push(`Expected ${key} argument to be an unsigned integer`);
        }
      }
      return value;
    };
    if (key === 'min') {
      min = getValue();
    } else if (key === 'max') {
      max = getValue();
    } else if (key === 'default') {
      defaultValue = getValue();
    } else if (key === 'step') {
      step = getValue();
    } else {
      errors.push(`Invalid parameter: ${key}`);
    }
  }
  if (min === undefined) {
    errors.push('min must be specified');
  }
  if (max === undefined) {
    errors.push('max must be specified');
  }
  if (min !== undefined && max !== undefined) {
    if (min > max) {
      errors.push('min must be less than max');
    }
    if (step === undefined) {
      if (valueType === 'float') {
        step = (max - min) / 100;
      } else {
        step = 1;
      }
    }
    if (defaultValue !== undefined) {
      if (defaultValue < min || defaultValue > max) {
        errors.push('default must be within valid range');
      }
    } else {
      if (valueType === 'float') {
        defaultValue = (min + max) / 2;
      } else {
        defaultValue = min;
      }
    }
  }
  if (errors.length > 0) {
    return {errors};
  } else {
    return {
      control: {type: 'slider', valueType, min, max, step, default: defaultValue} as
          ShaderSliderControl,
      errors: undefined,
    };
  }
}

function parseCheckboxDirective(
    valueType: string, parameters: DirectiveParameters): DirectiveParseResult {
  let defaultValue: boolean = false;
  let errors = [];
  if (valueType !== 'bool') {
    errors.push('type must be bool');
  }
  for (const [key, value] of parameters) {
    if (key === 'default') {
      if (typeof value !== 'boolean') {
        errors.push(`Expected ${key} argument to be a boolean`);
        continue;
      }
      defaultValue = value;
    } else {
      errors.push(`Invalid parameter: ${key}`);
    }
  }
  if (errors.length > 0) {
    return {errors};
  } else {
    return {
      control: {type: 'checkbox', valueType, default: defaultValue} as ShaderCheckboxControl,
      errors: undefined,
    };
  }
}

function parseColorDirective(
    valueType: string, parameters: DirectiveParameters): DirectiveParseResult {
  let defaultColor = 'white';
  let errors = [];
  if (valueType !== 'vec3') {
    errors.push('type must be vec3');
  }
  for (const [key, value] of parameters) {
    if (key === 'default') {
      if (typeof value !== 'string') {
        errors.push(`Expected default argument to be a string`);
      } else {
        defaultColor = value;
      }
    } else {
      errors.push(`Invalid parameter: ${key}`);
    }
  }
  if (errors.length > 0) {
    return {errors};
  }
  return {
    control: {
      type: 'color',
      valueType,
      defaultString: defaultColor,
      default: parseRGBColorSpecification(defaultColor)
    } as ShaderColorControl,
    errors: undefined
  };
}

function parseInvlerpChannel(value: unknown, rank: number) {
  if (typeof value === 'number') {
    value = [value];
  }
  const channel = new Array(rank);
  parseFixedLengthArray(channel, value, x => {
    if (!Number.isInteger(x) || x < 0) {
      throw new Error(`Expected non-negative integer, but received: ${JSON.stringify(x)}`);
    }
    return x;
  });
  return channel;
}

function parseInvlerpDirective(
    valueType: string, parameters: DirectiveParameters,
    dataContext: ShaderDataContext): DirectiveParseResult {
  const {imageData, properties} = dataContext;
  if (imageData !== undefined) {
    return parseImageInvlerpDirective(valueType, parameters, imageData);
  }
  if (properties !== undefined) {
    return parsePropertyInvlerpDirective(valueType, parameters, properties);
  }
  let errors = [];
  errors.push('invlerp control not supported');
  return {errors};
}

function parseImageInvlerpDirective(
    valueType: string, parameters: DirectiveParameters, imageData: ImageDataSpecification) {
  let errors = [];
  if (valueType !== 'invlerp') {
    errors.push('type must be invlerp');
  }
  let channel = new Array(imageData.channelRank).fill(0);
  const {dataType} = imageData;
  let clamp = true;
  let range = defaultDataTypeRange[dataType];
  let window: DataTypeInterval|undefined;
  for (let [key, value] of parameters) {
    try {
      switch (key) {
        case 'range': {
          range = parseDataTypeInterval(value, dataType);
          break;
        }
        case 'window': {
          window = validateDataTypeInterval(parseDataTypeInterval(value, dataType));
          break;
        }
        case 'clamp': {
          if (typeof value !== 'boolean') {
            errors.push(`Invalid clamp value: ${JSON.stringify(value)}`);
          } else {
            clamp = value;
          }
          break;
        }
        case 'channel': {
          channel = parseInvlerpChannel(value, channel.length);
          break;
        }
        default:
          errors.push(`Invalid parameter: ${key}`);
          break;
      }
    } catch (e) {
      errors.push(`Invalid ${key} value: ${e.message}`);
    }
  }
  if (errors.length > 0) {
    return {errors};
  }
  return {
    control: {
      type: 'imageInvlerp',
      dataType,
      clamp,
      default: {range, window: window ?? normalizeDataTypeInterval(range), channel},
    } as ShaderImageInvlerpControl,
    errors: undefined,
  };
}

function parsePropertyInvlerpDirective(
    valueType: string, parameters: DirectiveParameters, properties: Map<string, DataType>) {
  let errors = [];
  if (valueType !== 'invlerp') {
    errors.push('type must be invlerp');
  }
  let clamp = true;
  let range: any;
  let window: any;
  let property: string|undefined;
  for (let [key, value] of parameters) {
    try {
      switch (key) {
        case 'range': {
          range = parseUnknownDataTypeInterval(value);
          break;
        }
        case 'window': {
          window = parseUnknownDataTypeInterval(value);
          break;
        }
        case 'clamp': {
          if (typeof value !== 'boolean') {
            errors.push(`Invalid clamp value: ${JSON.stringify(value)}`);
          } else {
            clamp = value;
          }
          break;
        }
        case 'property': {
          const s = verifyString(value);
          if (!properties.has(s)) {
            throw new Error(`Property not defined: ${JSON.stringify(property)}`);
          }
          property = s;
          break;
        }
        default:
          errors.push(`Invalid parameter: ${key}`);
          break;
      }
    } catch (e) {
      errors.push(`Invalid ${key} value: ${e.message}`);
    }
  }
  if (errors.length > 0) {
    return {errors};
  }
  if (property === undefined) {
    for (const p of properties.keys()) {
      property = p;
      break;
    }
  }
  const dataType = properties.get(property!)!;
  if (range !== undefined) {
    range = convertDataTypeInterval(range, dataType);
  }
  if (window !== undefined) {
    window = convertDataTypeInterval(window, dataType);
  }
  return {
    control: {
      type: 'propertyInvlerp',
      clamp,
      properties,
      default: {range, window, property, dataType},
    } as ShaderPropertyInvlerpControl,
    errors: undefined,
  };
}

export interface ImageDataSpecification {
  dataType: DataType;
  channelRank: number;
}

export interface ShaderDataContext {
  imageData?: ImageDataSpecification;
  properties?: Map<string, DataType>;
}

const controlParsers = new Map<
    string,
    (valueType: string, parameters: DirectiveParameters, context: ShaderDataContext) =>
        DirectiveParseResult>([
  ['slider', parseSliderDirective],
  ['color', parseColorDirective],
  ['invlerp', parseInvlerpDirective],
  ['checkbox', parseCheckboxDirective],
]);

export function parseShaderUiControls(
    code: string, dataContext: ShaderDataContext = {}): ShaderControlsParseResult {
  code = stripComments(code);
  // Matches any #uicontrols directive.  Syntax errors in the directive are handled later.
  const directivePattern = /^[ \t]*#[ \t]*uicontrol[ \t]+(.*)$/mg;
  const innerPattern =
      /^([_a-zA-Z][_a-zA-Z0-9]*)[ \t]+([a-z][a-zA-Z0-9_]*)(?:[ \t]+([a-z]+))?[ \t]*(?:\([ \t]*(.*)\)[ \t]*)?/;
  let errors: {line: number, message: string}[] = [];
  const controls = new Map<string, ShaderUiControl>();
  const newCode = code.replace(directivePattern, (_match, innerPart: string, offset: number) => {
    const m = innerPart.match(innerPattern);
    const getLineNumber = () => {
      return Math.max(0, code.substring(0, offset).split('\n').length - 1);
    };
    if (m === null) {
      errors.push({
        line: getLineNumber(),
        message:
            'Invalid #uicontrol syntax, expected: #uicontrol <type> <name> <control>(<param>=<value>, ...)'
      });
      return '';
    }
    const typeName = m[1];
    const variableName = m[2];
    const controlName = m[3] ?? typeName;
    const parameterText = m[4];
    const {parameters, errors: innerErrors} = parseDirectiveParameters(parameterText);
    for (const error of innerErrors) {
      errors.push({line: getLineNumber(), message: error});
    }
    if (controls.has(variableName)) {
      errors.push(
          {line: getLineNumber(), message: `Duplicate definition for control ${variableName}`});
    }
    if (innerErrors.length > 0) {
      return '';
    }
    const parser = controlParsers.get(controlName);
    if (parser === undefined) {
      errors.push({line: getLineNumber(), message: `Invalid control type ${controlName}`});
      return '';
    }
    const result = parser(typeName, parameters, dataContext);
    if (result.errors !== undefined) {
      for (const error of result.errors) {
        errors.push({line: getLineNumber(), message: error});
      }
      return '';
    }
    controls.set(variableName, result.control);
    return '';
  });
  return {source: code, code: newCode, errors, controls};
}

export type Controls = Map<string, ShaderUiControl>;

function uniformName(controlName: string) {
  return `u_shaderControl_${controlName}`;
}

export function addControlsToBuilder(
    builderState: ShaderControlsBuilderState, builder: ShaderBuilder) {
  const {builderValues} = builderState;
  for (const [name, control] of builderState.parseResult.controls) {
    const uName = uniformName(name);
    const builderValue = builderValues[name];
    switch (control.type) {
      case 'imageInvlerp': {
        const code = [
          defineInvlerpShaderFunction(builder, uName, control.dataType, control.clamp), `
float ${uName}() {
  return ${uName}(getDataValue(${builderValue.channel.join(',')}));
}
`
        ];
        builder.addFragmentCode(code);
        builder.addFragmentCode(`#define ${name} ${uName}\n`);
        break;
      }
      case 'propertyInvlerp': {
        const property = builderValue.property;
        const dataType = control.properties.get(property)!;
        const code = [
          defineInvlerpShaderFunction(builder, uName, dataType, control.clamp), `
float ${uName}() {
  return ${uName}(prop_${property}());
}
`
        ];
        builder.addVertexCode(code);
        builder.addVertexCode(`#define ${name} ${uName}\n`);
        break;
      }
      case 'checkbox': {
        const code = `#define ${name} ${builderValue.value}\n`;
        builder.addFragmentCode(code);
        builder.addVertexCode(code);
        break;
      }
      default: {
        builder.addUniform(`highp ${control.valueType}`, uName);
        builder.addVertexCode(`#define ${name} ${uName}\n`);
        builder.addFragmentCode(`#define ${name} ${uName}\n`);
        break;
      }
    }
  }
}

function objectFromEntries(entries: Iterable<[string, any]>) {
  const obj: any = {};
  for (const [key, value] of entries) {
    obj[key] = value;
  }
  return obj;
}

function replaceMap(_key: string, value: unknown) {
  if (value instanceof Map) {
    return Array.from(value.entries());
  }
  return value;
}

function encodeControls(controls: Controls|undefined) {
  if (controls === undefined) return undefined;
  return JSON.stringify(objectFromEntries(controls), replaceMap);
}

export class WatchableShaderUiControls implements WatchableValueInterface<Controls|undefined> {
  changed = new NullarySignal();
  controls: Controls|undefined = undefined;
  get value() {
    return this.controls;
  }
  set value(newControls: Controls|undefined) {
    if (encodeControls(newControls) === encodeControls(this.controls)) {
      return;
    }
    this.controls = newControls;
    this.changed.dispatch();
  }
}

export interface InvlerpParameters {
  range: DataTypeInterval;
  window: DataTypeInterval;
}

export interface ImageInvlerpParameters extends InvlerpParameters {
  channel: number[];
}

export interface PropertyInvlerpParameters {
  range: DataTypeInterval|undefined;
  window: DataTypeInterval|undefined;
  property: string;
  dataType: DataType;
}

function parseImageInvlerpParameters(
    obj: unknown, dataType: DataType,
    defaultValue: ImageInvlerpParameters): ImageInvlerpParameters {
  if (obj === undefined) return defaultValue;
  verifyObject(obj);
  return {
    range: verifyOptionalObjectProperty(
        obj, 'range', x => parseDataTypeInterval(x, dataType), defaultValue.range),
    window: verifyOptionalObjectProperty(
        obj, 'window', x => validateDataTypeInterval(parseDataTypeInterval(x, dataType)),
        defaultValue.window),
    channel: verifyOptionalObjectProperty(
        obj, 'channel', x => parseInvlerpChannel(x, defaultValue.channel.length),
        defaultValue.channel),
  };
}

class TrackableImageInvlerpParameters extends TrackableValue<ImageInvlerpParameters> {
  constructor(public dataType: DataType, public defaultValue: ImageInvlerpParameters) {
    super(defaultValue, obj => parseImageInvlerpParameters(obj, dataType, defaultValue));
  }

  toJSON() {
    const {value: {range, window, channel}, dataType, defaultValue} = this;
    const rangeJson = dataTypeIntervalToJson(range, dataType, defaultValue.range);
    const windowJson = dataTypeIntervalToJson(window, dataType, defaultValue.window);
    const channelJson = arraysEqual(defaultValue.channel, channel) ? undefined : channel;
    if (rangeJson === undefined && windowJson === undefined && channelJson === undefined) {
      return undefined;
    }
    return {range: rangeJson, window: windowJson, channel: channelJson};
  }
}

function parsePropertyInvlerpParameters(
    obj: unknown, properties: PropertiesSpecification,
    defaultValue: PropertyInvlerpParameters): PropertyInvlerpParameters {
  if (obj === undefined) return defaultValue;
  verifyObject(obj);
  const property =
    verifyOptionalObjectProperty(obj, 'property', property => {
      property = verifyString(property);
      if (!properties.has(property)) {
        throw new Error(`Invalid value: ${JSON.stringify(property)}`);
      }
      return property;
    }, defaultValue.property);
  const dataType = properties.get(property)!;
  return {
    property,
    dataType,
    range: verifyOptionalObjectProperty(
        obj, 'range', x => parseDataTypeInterval(x, dataType), defaultValue.range),
    window: verifyOptionalObjectProperty(
        obj, 'window', x => validateDataTypeInterval(parseDataTypeInterval(x, dataType)),
        defaultValue.window),
  };
}

class TrackablePropertyInvlerpParameters extends TrackableValue<PropertyInvlerpParameters> {
  constructor(public properties: PropertiesSpecification, public defaultValue: PropertyInvlerpParameters) {
    super(defaultValue, obj => parsePropertyInvlerpParameters(obj, properties, defaultValue));
  }

  toJSON() {
    const {value: {range, window, property, dataType}, defaultValue} = this;
    const defaultRange = defaultDataTypeRange[dataType];
    const rangeJson =
        dataTypeIntervalToJson(range ?? defaultRange, dataType, defaultValue.range ?? defaultRange);
    const windowJson = dataTypeIntervalToJson(
        window ?? defaultRange, dataType, defaultValue.window ?? defaultRange);
    const propertyJson = property === defaultValue.property ? undefined : property;
    if (rangeJson === undefined && windowJson === undefined && propertyJson === undefined) {
      return undefined;
    }
    return {range: rangeJson, window: windowJson, property: propertyJson};
  }
}

function getControlTrackable(control: ShaderUiControl):
    {trackable: TrackableValueInterface<any>, getBuilderValue: (value: any) => any} {
  switch (control.type) {
    case 'slider':
      return {
        trackable: new TrackableValue<number>(
            control.default,
            x => {
              let v: number;
              if (control.valueType === 'float') {
                v = verifyFiniteFloat(x);
              } else {
                v = verifyInt(x);
              }
              if (v < control.min || v > control.max) {
                throw new Error(
                    `${JSON.stringify(x)} is outside valid range [${control.min}, ${control.max}]`);
              }
              return v;
            }),
        getBuilderValue: () => null,
      };
    case 'color':
      return {trackable: new TrackableRGB(control.default), getBuilderValue: () => null};
    case 'imageInvlerp':
      return {
        trackable: new TrackableImageInvlerpParameters(control.dataType, control.default),
        getBuilderValue: (value: ImageInvlerpParameters) =>
            ({channel: value.channel, dataType: control.dataType}),
      };
    case 'propertyInvlerp':
      return {
        trackable: new TrackablePropertyInvlerpParameters(control.properties, control.default),
        getBuilderValue: (value: PropertyInvlerpParameters) =>
            ({property: value.property, dataType: value.dataType}),
      };
    case 'checkbox':
      return {
        trackable: new TrackableBoolean(control.default),
        getBuilderValue: value => ({value}),
      };
  }
}

export interface SingleShaderControlState {
  control: ShaderUiControl;
  trackable: TrackableValueInterface<any>;
  getBuilderValue: (value: any) => any;
}

export type ShaderControlMap = Map<string, SingleShaderControlState>;

export type ShaderBuilderValues = {
  [key: string]: any
};

function encodeBuilderStateKey(
    builderValues: ShaderBuilderValues, parseResult: ShaderControlsParseResult) {
  return JSON.stringify(builderValues) + '\0' + parseResult.source;
}

export function getFallbackBuilderState(parseResult: ShaderControlsParseResult):
    ShaderControlsBuilderState {
  const builderValues: ShaderBuilderValues = {};
  const referencedProperties = [];
  for (const [key, control] of parseResult.controls) {
    const {trackable, getBuilderValue} = getControlTrackable(control);
    const builderValue = getBuilderValue(trackable.value);
    builderValues[key] = builderValue;
    if (control.type === 'propertyInvlerp') {
      referencedProperties.push(builderValue.property);
    }
  }
  return {
    builderValues,
    parseResult,
    key: encodeBuilderStateKey(builderValues, parseResult),
    referencedProperties,
  };
}

export class ShaderControlState extends RefCounted implements
    Trackable, WatchableValueInterface<ShaderControlMap> {
  changed = new NullarySignal();
  controls = new WatchableShaderUiControls();
  parseErrors: WatchableValueInterface<ShaderControlParseError[]>;
  processedFragmentMain: WatchableValueInterface<string>;
  parseResult: WatchableValueInterface<ShaderControlsParseResult>;
  builderState: WatchableValueInterface<ShaderControlsBuilderState>;
  histogramSpecifications: HistogramSpecifications;

  private fragmentMainGeneration = -1;
  private dataContextGeneration = -1;
  private parseErrors_: ShaderControlParseError[] = [];
  private processedFragmentMain_ = '';
  private parseResult_: ShaderControlsParseResult;
  private controlsGeneration = -1;
  private parseResultChanged = new NullarySignal();

  constructor(
      public fragmentMain: WatchableValueInterface<string>,
      public dataContext:
          WatchableValueInterface<ShaderDataContext|null> = constantWatchableValue({}),
      public channelCoordinateSpaceCombiner?: CoordinateSpaceCombiner|undefined) {
    super();
    this.registerDisposer(fragmentMain.changed.add(() => this.handleFragmentMainChanged()));
    this.registerDisposer(this.controls.changed.add(() => this.handleControlsChanged()));
    this.registerDisposer(this.dataContext.changed.add(() => this.handleFragmentMainChanged()));
    this.handleFragmentMainChanged();
    const self = this;
    this.parseErrors = {
      changed: this.parseResultChanged,
      get value() {
        self.handleFragmentMainChanged();
        return self.parseErrors_;
      }
    };
    this.processedFragmentMain = {
      changed: this.parseResultChanged,
      get value() {
        self.handleFragmentMainChanged();
        return self.processedFragmentMain_;
      }
    };
    this.parseResult = {
      changed: this.parseResultChanged,
      get value() {
        return self.parseResult_;
      }
    };
    this.builderState = makeCachedDerivedWatchableValue(
        (parseResult: ShaderControlsParseResult, state: ShaderControlMap) => {
          const builderValues: ShaderBuilderValues = {};
          const referencedProperties = [];
          for (const [key, {control, trackable, getBuilderValue}] of state) {
            const builderValue = getBuilderValue(trackable.value);
            builderValues[key] = builderValue;
            if (control.type === 'propertyInvlerp') {
              referencedProperties.push(builderValue.property);
            }
          }
          return {
            key: encodeBuilderStateKey(builderValues, parseResult),
            parseResult,
            builderValues,
            referencedProperties,
          };
        },
        [this.parseResult, this], (a, b) => a.key === b.key);
    const histogramChannels = makeCachedDerivedWatchableValue(
        state => {
          const channels: HistogramChannelSpecification[] = [];
          for (const {control, trackable} of state.values()) {
            if (control.type !== 'imageInvlerp') continue;
            channels.push({channel: trackable.value.channel});
          }
          return channels;
        },
        [this],
        (a, b) => arraysEqualWithPredicate(a, b, (ca, cb) => arraysEqual(ca.channel, cb.channel)));
    const histogramProperties = makeCachedDerivedWatchableValue(state => {
      const properties: string[] = [];
      for (const {control, trackable} of state.values()) {
        if (control.type !== 'propertyInvlerp') continue;
        properties.push(trackable.value.property);
      }
      return properties;
    }, [this], arraysEqual);
    const histogramBounds = makeCachedLazyDerivedWatchableValue(state => {
      const bounds: DataTypeInterval[] = [];
      for (const {control, trackable} of state.values()) {
        if (control.type === 'imageInvlerp') {
          bounds.push(trackable.value.window);
        } else if (control.type === 'propertyInvlerp') {
          const {dataType, range, window} = trackable.value as PropertyInvlerpParameters;
          bounds.push(window ?? range ?? defaultDataTypeRange[dataType]);
        }
      }
      return bounds;
    }, this);
    this.histogramSpecifications = this.registerDisposer(
        new HistogramSpecifications(histogramChannels, histogramProperties, histogramBounds));
  }

  private handleFragmentMainChanged() {
    const generation = this.fragmentMain.changed.count;
    const dataContextGeneration = this.dataContext.changed.count;
    if (generation === this.fragmentMainGeneration &&
        dataContextGeneration === this.dataContextGeneration) {
      return;
    }
    this.fragmentMainGeneration = generation;
    this.dataContextGeneration = dataContextGeneration;
    const dataContext = this.dataContext.value;
    if (dataContext === null) {
      this.parseResult_ = {
        source: '',
        code: '',
        controls: new Map(),
        errors: [{line: 0, message: 'Loading'}],
      };
      this.parseErrors_ = [];
      this.processedFragmentMain_ = '';
      this.controls.value = undefined;
    } else {
      const result = this.parseResult_ =
          parseShaderUiControls(this.fragmentMain.value, dataContext);
      this.parseErrors_ = result.errors;
      this.processedFragmentMain_ = result.code;
      if (result.errors.length === 0) {
        this.controls.value = result.controls;
      }
    }
    this.parseResultChanged.dispatch();
  }

  private handleControlsChanged() {
    const generation = this.controls.changed.count;
    if (generation === this.controlsGeneration) {
      return;
    }
    this.controlsGeneration = generation;
    const controls = this.controls.value;
    if (controls === undefined) {
      return;
    }
    let changed = false;
    const {state_, unparsedJson} = this;
    // Remove values in `state` not in `controls`.
    for (const [name, controlState] of state_) {
      const control = controls.get(name);
      if (control === undefined) {
        controlState.trackable.changed.remove(this.changed.dispatch);
        state_.delete(name);
        changed = true;
        continue;
      }
    }
    for (const [name, control] of controls) {
      let controlState = state_.get(name);
      if (controlState !== undefined &&
          JSON.stringify(controlState.control) !== JSON.stringify(control)) {
        controlState.trackable.changed.remove(this.changed.dispatch);
        controlState = undefined;
      }
      if (controlState === undefined) {
        const {trackable, getBuilderValue} = getControlTrackable(control);
        controlState = {control, trackable, getBuilderValue};
        controlState.trackable.changed.add(this.changed.dispatch);
        state_.set(name, controlState);
        changed = true;
      }
      if (unparsedJson !== undefined && unparsedJson.hasOwnProperty(name)) {
        changed = true;
        try {
          controlState.trackable.restoreState(unparsedJson[name]);
        } catch {
          // Ignore error
        }
      }
    }
    if (unparsedJson !== undefined) {
      changed = true;
    }
    this.unparsedJson = undefined;
    if (changed) {
      this.changed.dispatch();
    }
  }

  private state_: ShaderControlMap = new Map();

  get state() {
    if (this.controls.changed.count !== this.controlsGeneration) {
      this.handleControlsChanged();
    }
    return this.state_;
  }

  get value() {
    return this.state;
  }

  private unparsedJson: any = undefined;

  restoreState(value: any) {
    if (value === undefined) return;
    const {state} = this;
    verifyObject(value);
    const controls = this.controls.value;
    if (controls === undefined) {
      this.unparsedJson = value;
      this.changed.dispatch();
      return;
    }
    for (const [key, controlState] of state) {
      const {trackable} = controlState;
      trackable.reset();
      if (value.hasOwnProperty(key)) {
        try {
          trackable.restoreState(value[key]);
        } catch {
          // Ignore error
        }
      }
    }
    this.unparsedJson = undefined;
  }

  reset() {
    for (const controlState of this.state.values()) {
      controlState.trackable.reset();
    }
    if (this.unparsedJson !== undefined) {
      this.unparsedJson = undefined;
      this.changed.dispatch();
    }
  }

  toJSON() {
    const {state} = this;
    const {unparsedJson} = this;
    if (unparsedJson !== undefined) return unparsedJson;
    const obj: any = {};
    let empty = true;
    for (const [key, value] of state) {
      const valueJson = value.trackable.toJSON();
      ;
      if (valueJson !== undefined) {
        obj[key] = valueJson;
        empty = false;
      }
    }
    if (empty) return undefined;
    return obj;
  }
}

function setControlInShader(
    gl: GL, shader: ShaderProgram, name: string, control: ShaderUiControl, value: any) {
  const uName = uniformName(name);
  const uniform = shader.uniform(uName);
  switch (control.type) {
    case 'slider':
      switch (control.valueType) {
        case 'int':
        case 'uint':
          gl.uniform1i(uniform, value);
          break;
        case 'float':
          gl.uniform1f(uniform, value);
      }
      break;
    case 'color':
      gl.uniform3fv(uniform, value);
      break;
    case 'imageInvlerp':
      enableLerpShaderFunction(shader, uName, control.dataType, value.range);
      break;
    case 'propertyInvlerp': {
      const {dataType} = value as PropertyInvlerpParameters;
      enableLerpShaderFunction(
          shader, uName, dataType, value.range ?? defaultDataTypeRange[dataType]);
      break;
    }
    case 'checkbox':
      // Value is hard-coded in shader.
      break;
  }
}

export function setControlsInShader(
    gl: GL, shader: ShaderProgram, shaderControlState: ShaderControlState, controls: Controls) {
  const {state} = shaderControlState;
  if (shaderControlState.controls.value === controls) {
    // Case when shader doesn't have any errors.
    for (const [name, controlState] of state) {
      setControlInShader(gl, shader, name, controlState.control, controlState.trackable.value);
    }
  } else {
    // Case when shader does have errors and we are using the fallback shader, which may have a
    // different/incompatible set of controls.
    for (const [name, control] of controls) {
      const controlState = state.get(name);
      const value = (controlState !== undefined &&
                     JSON.stringify(controlState.control) === JSON.stringify(control)) ?
          controlState.trackable.value :
          control.default;
      setControlInShader(gl, shader, name, control, value);
    }
  }
}

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

import {TrackableValue, TrackableValueInterface, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {parseRGBColorSpecification, TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {verifyFiniteFloat, verifyInt, verifyObject} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {GL} from 'neuroglancer/webgl/context';
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

export type ShaderUiControl = ShaderSliderControl|ShaderColorControl;

export interface ShaderControlParseError {
  line: number;
  message: string;
}

export interface ShaderControlsParseResult {
  source: string;
  code: string;
  controls: Map<string, ShaderUiControl>;
  errors: ShaderControlParseError[];
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

type DirectiveParameters = Map<string, string|number>;

export function parseDirectiveParameters(input: string|undefined):
    {parameters: DirectiveParameters, errors: string[]} {
  let errors: string[] = [];
  let parameters = new Map<string, number|string>();
  if (input === undefined) {
    return {errors, parameters};
  }
  const pattern =
      /^[ \t]*([_a-z][_a-zA-Z0-9]*)[ \t]*=[ \t]*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:\\.|[^\\"])*")[ \t]*/;
  while (true) {
    input = input.trim();
    if (input.length == 0) break;
    const m = input.match(pattern);
    if (m === null) {
      errors.push('Invalid #uicontrol parameter syntax, expected: <param>=<value>, ...');
      break;
    }
    const name = m[1];
    let value;
    try {
      value = JSON.parse(m[2]);
    } catch {
      errors.push(`Invalid #uicontrol parameter value: ${value}`);
      break;
    }
    if (parameters.has(name)) {
      errors.push(`Duplicate #uicontrol parameter: ${name}`);
    } else {
      parameters.set(name, value);
    }
    input = input.substring(m[0].length);
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
      control: {type: 'slider', valueType, min, max, step, default: defaultValue} as ShaderSliderControl,
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

const controlParsers =
    new Map<string, (valueType: string, parameters: DirectiveParameters) => DirectiveParseResult>(
        [['slider', parseSliderDirective], ['color', parseColorDirective]]);


export function parseShaderUiControls(code: string): ShaderControlsParseResult {
  code = stripComments(code);
  // Matches any #uicontrols directive.  Syntax errors in the directive are handled later.
  const directivePattern = /^[ \t]*#[ \t]*uicontrol[ \t]+(.*)$/mg;
  const innerPattern =
      /^([_a-zA-Z][_a-zA-Z0-9]*)[ \t]+([a-z][a-zA-Z0-9]*)[ \t]+([a-z]+)[ \t]*(?:\([ \t]*(.*)\)[ \t]*)?/;
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
    const controlName = m[3];
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
    const result = parser(typeName, parameters);
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

export function addControlsToBuilder(controls: Controls, builder: ShaderBuilder) {
  for (const [name, control] of controls) {
    builder.addUniform(`highp ${control.valueType}`, uniformName(name));
    builder.addFragmentCode(`#define ${name} ${uniformName(name)}\n`);
  }
}

function objectFromEntries(entries: Iterable<[string, any]>) {
  const obj: any = {};
  for (const [key, value] of entries) {
    obj[key] = value;
  }
  return obj;
}

function encodeControls(controls: Controls|undefined) {
  if (controls === undefined) return undefined;
  return JSON.stringify(objectFromEntries(controls));
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

function getControlTrackable(control: ShaderUiControl): TrackableValueInterface<any> {
  switch (control.type) {
    case 'slider':
      return new TrackableValue<number>(control.default, x => {
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
      });
    case 'color':
      return new TrackableRGB(control.default);
  }
}

export class ShaderControlState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  controls = new WatchableShaderUiControls();
  parseErrors: WatchableValueInterface<ShaderControlParseError[]>;
  processedFragmentMain: WatchableValueInterface<string>;
  parseResult: WatchableValueInterface<ShaderControlsParseResult>;
  private fragmentMainGeneration = -1;
  private parseErrors_: ShaderControlParseError[] = [];
  private processedFragmentMain_ = '';
  private parseResult_: ShaderControlsParseResult;
  private controlsGeneration = -1;

  constructor(public fragmentMain: WatchableValueInterface<string>) {
    super();
    this.registerDisposer(fragmentMain.changed.add(() => this.handleFragmentMainChanged()));
    this.registerDisposer(this.controls.changed.add(() => this.handleControlsChanged()));
    this.handleFragmentMainChanged();
    const self = this;
    this.parseErrors = {
      changed: fragmentMain.changed,
      get value() {
        self.handleFragmentMainChanged();
        return self.parseErrors_;
      }
    };
    this.processedFragmentMain = {
      changed: fragmentMain.changed,
      get value() {
        self.handleFragmentMainChanged();
        return self.processedFragmentMain_;
      }
    };
    this.parseResult = {
      changed: fragmentMain.changed,
      get value() {
        return self.parseResult_;
      }
    };
  }

  private handleFragmentMainChanged() {
    const generation = this.fragmentMain.changed.count;
    if (generation === this.fragmentMainGeneration) return;
    this.fragmentMainGeneration = generation;
    const result = this.parseResult_ = parseShaderUiControls(this.fragmentMain.value);
    this.parseErrors_ = result.errors;
    this.processedFragmentMain_ = result.code;
    if (result.errors.length === 0) {
      this.controls.value = result.controls;
    }
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
        controlState = {control, trackable: getControlTrackable(control)};
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

  private state_ =
      new Map<string, {control: ShaderUiControl, trackable: TrackableValueInterface<any>}>();

  get state() {
    if (this.controls.changed.count !== this.controlsGeneration) {
      this.handleControlsChanged();
    }
    return this.state_;
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
      const valueJson = value.trackable.toJSON();;
      if (valueJson !== undefined) {
        obj[key] = valueJson;
        empty = false;
      }
    }
    if (empty) return undefined;
    return obj;
  }
}

function setControlInShader(gl: GL, shader: ShaderProgram, name: string, control: ShaderUiControl, value: any) {
  const uniform = shader.uniform(uniformName(name));
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

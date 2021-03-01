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

import {constantWatchableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {stableStringify, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderCompilationError, ShaderLinkError, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';

/**
 * undefined means shader has not been compiled.  null means shader was compiled successfully.
 */
export type WatchableShaderError =
    WatchableValue<ShaderCompilationError|ShaderLinkError|undefined|null>;

export function makeWatchableShaderError() {
  return new WatchableValue<ShaderCompilationError|ShaderLinkError|undefined|null>(undefined);
}

export type TrackableFragmentMain = TrackableValue<string>;

export function makeTrackableFragmentMain(value: string) {
  return new TrackableValue<string>(value, verifyString);
}

export interface ParameterizedShaderGetterResult<Parameters = any, ExtraParameters = any> {
  shader: ShaderProgram|null;
  fallback: boolean;
  parameters: Parameters;
  extraParameters: ExtraParameters;
}

export interface ParameterizedContextDependentShaderGetter<
    Context, Parameters, ExtraParameters = undefined> {
  (context: Context): ParameterizedShaderGetterResult<Parameters, ExtraParameters>;
}

export interface ParameterizedShaderOptions<Parameters = any, ExtraParameters = any> {
  memoizeKey: any;
  parameters: WatchableValueInterface<Parameters>;
  fallbackParameters?: WatchableValueInterface<Parameters>|undefined;
  shaderError?: WatchableShaderError|undefined;
  encodeParameters?: (p: Parameters) => any;
  extraParameters?: WatchableValueInterface<ExtraParameters>;
  encodeExtraParameters?: (p: ExtraParameters) => any;
}

export function parameterizedContextDependentShaderGetter<
    Context, ContextKey, Parameters, ExtraParameters = undefined>(
    refCounted: RefCounted, gl: GL,
    options: ParameterizedShaderOptions<Parameters, ExtraParameters>&{
      getContextKey: (context: Context) => ContextKey,
      defineShader:
          (builder: ShaderBuilder, context: Context, parameters: Parameters,
           extraParameters: ExtraParameters) => void,
      encodeContext?: (context: Context) => any,
    }): ParameterizedContextDependentShaderGetter<Context, Parameters, ExtraParameters> {
  const shaders = new Map<ContextKey, ParameterizedShaderGetterResult<Parameters, ExtraParameters>&{
    parametersGeneration: number,
    extraParametersGeneration: number,
  }>();
  const {
    parameters,
    fallbackParameters,
    shaderError,
    encodeParameters = (p: Parameters) => p,
    extraParameters = constantWatchableValue(undefined as any as ExtraParameters),
    encodeExtraParameters = (p: ExtraParameters) => p,
    getContextKey,
    defineShader
  } = options;
  if (shaderError !== undefined) {
    shaderError.value = undefined;
  }
  const {encodeContext = getContextKey} = options;
  const stringMemoizeKey = stableStringify(options.memoizeKey);
  function getNewShader(
      context: Context, parameters: Parameters, extraParameters: ExtraParameters) {
    const key = JSON.stringify({
      id: stringMemoizeKey,
      context: encodeContext(context),
      parameters: encodeParameters(parameters),
      extraParameters: encodeExtraParameters(extraParameters),
    });
    return gl.memoize.get(key, () => {
      const builder = new ShaderBuilder(gl);
      defineShader(builder, context, parameters, extraParameters);
      return builder.build();
    });
  }
  function getter(context: Context) {
    const contextKey = getContextKey(context);
    let entry = shaders.get(contextKey);
    if (entry === undefined) {
      entry = {
        parametersGeneration: -1,
        extraParametersGeneration: -1,
        shader: null,
        fallback: false,
        parameters: parameters.value,
        extraParameters: extraParameters.value,
      };
      shaders.set(contextKey, entry);
    }
    const parametersGeneration = parameters.changed.count;
    const extraParametersGeneration = extraParameters.changed.count;
    if (parametersGeneration === entry.parametersGeneration &&
        extraParametersGeneration === entry.extraParametersGeneration) {
      return entry;
    }
    const parametersValue = entry.parameters = parameters.value;
    const extraParametersValue = entry.extraParameters = extraParameters.value;
    const oldShader = entry.shader;
    entry.parametersGeneration = parametersGeneration;
    entry.extraParametersGeneration = extraParametersGeneration;
    let newShader: ShaderProgram|null = null;
    try {
      newShader = getNewShader(context, parametersValue, extraParametersValue);
      entry.fallback = false;
      if (fallbackParameters !== undefined) {
        fallbackParameters.value = parametersValue;
      }
      if (shaderError !== undefined) {
        shaderError.value = null;
      }
    } catch (e) {
      if (shaderError !== undefined) {
        shaderError.value = e;
      }
      if (fallbackParameters !== undefined) {
        try {
          const fallbackParametersValue = fallbackParameters.value;
          newShader = getNewShader(context, fallbackParametersValue, extraParametersValue);
          entry.parameters = fallbackParametersValue;
          entry.fallback = true;
        } catch {
        }
      }
    }
    if (oldShader !== null) {
      oldShader.dispose();
    }
    entry.shader = newShader;
    return entry;
  }
  refCounted.registerDisposer(() => {
    for (const entry of shaders.values()) {
      const {shader} = entry;
      if (shader !== null) {
        shader.dispose();
      }
    }
  });
  return getter;
}

export interface ParameterizedEmitterDependentShaderOptions<
    Parameters = any, ExtraParameters = any> extends
    ParameterizedShaderOptions<Parameters, ExtraParameters> {
  defineShader:
      (builder: ShaderBuilder, parameters: Parameters, extraParameters: ExtraParameters) => void;
}

export type ParameterizedEmitterDependentShaderGetter<Parameters = any, ExtraParameters = any> =
    ParameterizedContextDependentShaderGetter<ShaderModule, Parameters, ExtraParameters>;

export function parameterizedEmitterDependentShaderGetter<Parameters, ExtraParameters = undefined>(
    refCounted: RefCounted, gl: GL,
    options: ParameterizedEmitterDependentShaderOptions<Parameters, ExtraParameters>):
    ParameterizedEmitterDependentShaderGetter<Parameters, ExtraParameters> {
  return parameterizedContextDependentShaderGetter(refCounted, gl, {
    ...options,
    getContextKey: (emitter: ShaderModule) => emitter,
    encodeContext: (emitter: ShaderModule) => getObjectId(emitter),
    defineShader: (builder, emitter: ShaderModule, parameters, extraParameters) => {
      builder.require(emitter);
      return options.defineShader(builder, parameters, extraParameters);
    },
  });
}

export function shaderCodeWithLineDirective(code: string, sourceStringNumber = 1, line = 0) {
  return `\n#line ${line} ${sourceStringNumber}\n` + code;
}

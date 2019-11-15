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

import {WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
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

export class ShaderGetter extends RefCounted {
  shaderUpdated = true;
  shader: ShaderProgram|undefined = undefined;

  invalidateShader() {
    this.shaderUpdated = true;
  }
  constructor(
      public gl: GL, private defineShader: (builder: ShaderBuilder) => void,
      private getShaderKey: () => string,
      public shaderError: WatchableShaderError = makeWatchableShaderError()) {
    super();
    shaderError.value = undefined;
  }

  get(): ShaderProgram|undefined {
    if (!this.shaderUpdated) {
      return this.shader;
    }
    this.shaderUpdated = false;
    try {
      let newShader = this.getShader();
      this.disposeShader();
      this.shader = newShader;
      this.shaderError.value = null;
    } catch (shaderError) {
      this.shaderError.value = shaderError;
    }
    return this.shader;
  }

  private getShader() {
    let key = this.getShaderKey();
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  private buildShader() {
    let builder = new ShaderBuilder(this.gl);
    this.defineShader(builder);
    return builder.build();
  }
  disposed() {
    super.disposed();
    this.disposeShader();
  }
  private disposeShader() {
    if (this.shader) {
      this.shader.dispose();
      this.shader = undefined;
    }
  }
}

export interface ParameterizedShaderGetterResult<Parameters> {
  shader: ShaderProgram|null;
  fallback: boolean;
  parameters: Parameters;
}

export interface ParameterizedContextDependentShaderGetter<Context, Parameters> {
  (context: Context): ParameterizedShaderGetterResult<Parameters>;
}

export function parameterizedContextDependentShaderGetter<Parameters, Context, ContextKey>(
    refCounted: RefCounted, gl: GL, options: {
      memoizeKey: any,
      parameters: WatchableValueInterface<Parameters>,
      getContextKey: (context: Context) => ContextKey,
      shaderError: WatchableShaderError,
      defineShader: (builder: ShaderBuilder, parameters: Parameters, context: Context) => void,
      fallbackParameters?: WatchableValueInterface<Parameters>,
      encodeContext?: (context: Context) => any,
      encodeParameters?: (parameters: Parameters) => any,
    }): ParameterizedContextDependentShaderGetter<Context, Parameters> {
  const shaders = new Map<ContextKey, {
    generation: number,
    shader: ShaderProgram | null,
    fallback: boolean,
    parameters: Parameters
  }>();
  const {
    parameters,
    fallbackParameters,
    shaderError,
    encodeParameters = (p: Parameters) => p,
    getContextKey,
    defineShader
  } = options;
  const {encodeContext = getContextKey} = options;
  const stringMemoizeKey = stableStringify(options.memoizeKey);
  function getNewShader(parameters: Parameters, context: Context) {
    const key = JSON.stringify({
      id: stringMemoizeKey,
      context: encodeContext(context),
      parameters: encodeParameters(parameters)
    });
    return gl.memoize.get(key, () => {
      const builder = new ShaderBuilder(gl);
      defineShader(builder, parameters, context);
      return builder.build();
    });
  }
  function getter(context: Context) {
    const contextKey = encodeContext(context);
    let entry = shaders.get(contextKey);
    if (entry === undefined) {
      entry = {generation: -1, shader: null, fallback: false, parameters: parameters.value};
      shaders.set(contextKey, entry);
    }
    const generation = parameters.changed.count;
    if (generation === entry.generation) {
      return entry;
    }
    const parametersValue = entry.parameters = parameters.value;
    const oldShader = entry.shader;
    entry.generation = generation;
    let newShader: ShaderProgram|null = null;
    try {
      newShader = getNewShader(parametersValue, context);
      entry.fallback = false;
      if (fallbackParameters !== undefined) {
        fallbackParameters.value = parametersValue;
      }
      shaderError.value = null;
    } catch (e) {
      shaderError.value = e;
      if (fallbackParameters !== undefined) {
        try {
          const fallbackParametersValue = fallbackParameters.value;
          newShader = getNewShader(fallbackParametersValue, context);
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

export function parameterizedEmitterDependentShaderGetter<T>(
    refCounted: RefCounted, gl: GL, memoizeKey: any, fallbackParameters: WatchableValueInterface<T>,
    parameters: WatchableValueInterface<T>, shaderError: WatchableShaderError,
    defineShader: (builder: ShaderBuilder, parameters: T) =>
        void): ((emitter: ShaderModule) => ShaderProgram | null) {
  const getter = parameterizedContextDependentShaderGetter(refCounted, gl, {
    memoizeKey,
    fallbackParameters,
    parameters,
    getContextKey: (emitter: ShaderModule) => emitter,
    encodeContext: (emitter: ShaderModule) => getObjectId(emitter),
    shaderError,
    defineShader: (builder, parameters, emitter: ShaderModule) => {
      builder.require(emitter);
      return defineShader(builder, parameters);
    },
  });
  return (emitter: ShaderModule) => getter(emitter).shader;
}

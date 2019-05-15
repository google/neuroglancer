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

export function parameterizedEmitterDependentShaderGetter<T>(
    refCounted: RefCounted, gl: GL, memoizeKey: any, fallbackParameters: WatchableValueInterface<T>,
    parameters: WatchableValueInterface<T>, shaderError: WatchableShaderError,
    defineShader: (builder: ShaderBuilder, parameters: T) =>
        void): ((emitter: ShaderModule) => ShaderProgram | null) {
  const shaders = new Map<ShaderModule, {generation: number, shader: ShaderProgram | null}>();
  const stringMemoizeKey = stableStringify(memoizeKey);
  function getNewShader(p: T, emitter: ShaderModule) {
    const key = stringMemoizeKey + '\0' + getObjectId(emitter) + '\0' + JSON.stringify(parameters);
    return gl.memoize.get(key, () => {
      const builder = new ShaderBuilder(gl);
      builder.require(emitter);
      defineShader(builder, p);
      return builder.build();
    });
  }
  function getter(emitter: ShaderModule) {
    let entry = shaders.get(emitter);
    if (entry === undefined) {
      entry = {generation: -1, shader: null};
      shaders.set(emitter, entry);
    }
    const generation = parameters.changed.count;
    if (generation === entry.generation) {
      return entry.shader;
    }
    const oldShader = entry.shader;
    entry.generation = generation;
    let newShader: ShaderProgram|null = null;
    try {
      newShader = getNewShader(parameters.value, emitter);
      fallbackParameters.value = parameters.value;
      shaderError.value = null;
    } catch (e) {
      shaderError.value = e;
      try {
        newShader = getNewShader(fallbackParameters.value, emitter);
      } catch {
      }
    }
    if (oldShader !== null) {
      oldShader.dispose();
    }
    entry.shader = newShader;
    return newShader;
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

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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {RenderLayer as GenericRenderLayer} from 'neuroglancer/layer';
import {SliceView, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {BoundingBox, vec3} from 'neuroglancer/util/geom';
import {makeWatchableShaderError, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {RpcId} from 'neuroglancer/worker_rpc';

const tempVec3 = vec3.create();

export abstract class RenderLayer extends GenericRenderLayer {
  chunkManager: ChunkManager;
  sources: SliceViewChunkSource[][]|null = null;
  sourceIds: number[][] = [];
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;
  shaderError: WatchableShaderError;
  constructor(chunkManager: ChunkManager, sources: SliceViewChunkSource[][], {
    shaderError = makeWatchableShaderError(),
  } = {}) {
    super();

    this.shaderError = shaderError;
    shaderError.value = undefined;
    this.chunkManager = chunkManager;
    this.sources = sources;

    for (let alternatives of sources) {
      let alternativeIds: number[] = [];
      this.sourceIds.push(alternativeIds);
      for (let source of alternatives) {
        alternativeIds.push(source.rpcId!);
      }
    }

    let spec = this.sources[0][0].spec;
    let {chunkLayout} = spec;

    const voxelSize = this.voxelSize =
        chunkLayout.localSpatialVectorToGlobal(vec3.create(), spec.voxelSize);
    for (let i = 0; i < 3; ++i) {
      voxelSize[i] = Math.abs(voxelSize[i]);
    }

    const boundingBox = this.boundingBox = new BoundingBox(
        vec3.fromValues(Infinity, Infinity, Infinity),
        vec3.fromValues(-Infinity, -Infinity, -Infinity));
    const globalCorner = vec3.create();
    const localCorner = tempVec3;

    for (let cornerIndex = 0; cornerIndex < 8; ++cornerIndex) {
      for (let i = 0; i < 3; ++i) {
        localCorner[i] = cornerIndex & (1 << i) ? spec.upperClipBound[i] : spec.lowerClipBound[i];
      }
      chunkLayout.localSpatialToGlobal(globalCorner, localCorner);
      vec3.min(boundingBox.lower, boundingBox.lower, globalCorner);
      vec3.max(boundingBox.upper, boundingBox.upper, globalCorner);
    }
    this.setReady(true);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  initializeShader() {
    if (!this.shaderUpdated) {
      return;
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
  }

  disposeShader() {
    if (this.shader) {
      this.shader.dispose();
      this.shader = undefined;
    }
  }

  disposed() {
    super.disposed();
    this.disposeShader();
  }

  getShaderKey() {
    return '';
  }

  getShader() {
    let key = this.getShaderKey();
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  buildShader() {
    let builder = new ShaderBuilder(this.gl);
    this.defineShader(builder);
    return builder.build();
  }

  abstract defineShader(builder: ShaderBuilder): void;
  abstract beginSlice(_sliceView: SliceView): ShaderProgram;
  abstract endSlice(shader: ShaderProgram): void;
  abstract draw(sliceView: SliceView): void;
}

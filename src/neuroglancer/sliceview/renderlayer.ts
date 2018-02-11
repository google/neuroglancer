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
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayer as GenericRenderLayer} from 'neuroglancer/layer';
import {getTransformedSources, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {SliceView, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {BoundingBox, vec3} from 'neuroglancer/util/geom';
import {makeWatchableShaderError, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {RpcId} from 'neuroglancer/worker_rpc';
import {SharedObject} from 'neuroglancer/worker_rpc';

const tempVec3 = vec3.create();

export interface RenderLayerOptions {
  transform: CoordinateTransform;
  shaderError: WatchableShaderError;
  rpcType: string;
  rpcTransfer: { [index:string]: number|string|null };
}

export abstract class RenderLayer extends GenericRenderLayer {
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;
  rpcType: string = SLICEVIEW_RENDERLAYER_RPC_ID;
  rpcTransfer: { [index:string]: number|string|null } = {};
  shaderError: WatchableShaderError;
  transform: CoordinateTransform;
  transformedSources: {source: SliceViewChunkSource, chunkLayout: ChunkLayout}[][];
  transformedSourcesGeneration = -1;

  constructor(
      public chunkManager: ChunkManager, public sources: SliceViewChunkSource[][],
      options: Partial<RenderLayerOptions> = {}) {
    super();

    const {
      rpcType = SLICEVIEW_RENDERLAYER_RPC_ID,
      rpcTransfer = {},
      transform = new CoordinateTransform(),
      shaderError = makeWatchableShaderError()
    } = options;

    this.rpcType = rpcType;
    this.rpcTransfer = rpcTransfer;
    this.transform = transform;
    this.shaderError = shaderError;
    shaderError.value = undefined;

    const transformedSources = getTransformedSources(this);

    {
      const {source, chunkLayout} = transformedSources[0][0];
      const {spec} = source;
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
    }

    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = this.rpcType;
    const sourceIds = sources.map(alternatives => alternatives.map(source => source.rpcId!));
    sharedObject.initializeCounterpart(
        rpc, {'sources': sourceIds, 'transform': transform.transform, ...rpcTransfer});
    this.rpcId = sharedObject.rpcId;

    this.registerDisposer(transform.changed.add(() => {
      rpc.invoke(
          SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID,
          {id: this.rpcId, value: transform.transform});
    }));

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

  setGLBlendMode(gl: WebGLRenderingContext, renderLayerNum: number): void {
    // Default blend mode for non-blend-mode-aware layers
    if (renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  abstract defineShader(builder: ShaderBuilder): void;
  abstract beginSlice(_sliceView: SliceView): ShaderProgram;
  abstract endSlice(shader: ShaderProgram): void;
  abstract draw(sliceView: SliceView): void;
}

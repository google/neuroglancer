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
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {getTransformedSources, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_RENDERLAYER_UPDATE_TRANSFORM_RPC_ID, TransformedSource} from 'neuroglancer/sliceview/base';
import {SliceView, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {vec3} from 'neuroglancer/util/geom';
import {RpcId} from 'neuroglancer/worker_rpc';
import {SharedObject} from 'neuroglancer/worker_rpc';

export interface RenderLayerOptions {
  transform?: CoordinateTransform;
  renderScaleTarget?: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;
}

export abstract class RenderLayer extends GenericRenderLayer {
  rpcId: RpcId|null = null;
  transform: CoordinateTransform;
  transformedSources: TransformedSource<SliceViewChunkSource>[][];
  transformedSourcesGeneration = -1;
  renderScaleTarget: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;

  constructor(
      public chunkManager: ChunkManager, public sources: SliceViewChunkSource[][],
      options: RenderLayerOptions) {
    super();

    const {
      transform = new CoordinateTransform(),
      renderScaleTarget = trackableRenderScaleTarget(1)
    } = options;
    this.renderScaleTarget = renderScaleTarget;
    this.renderScaleHistogram = options.renderScaleHistogram;
    this.transform = transform;
    const transformedSources = getTransformedSources(this);

    {
      const {source, chunkLayout} = transformedSources[0][0];
      const {spec} = source;
      const voxelSize = this.voxelSize =
          chunkLayout.localSpatialVectorToGlobal(vec3.create(), spec.voxelSize);
      for (let i = 0; i < 3; ++i) {
        voxelSize[i] = Math.abs(voxelSize[i]);
      }
    }

    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;
    const sourceIds = sources.map(alternatives => alternatives.map(source => source.rpcId!));
    sharedObject.initializeCounterpart(rpc, {
      sources: sourceIds,
      transform: transform.transform,
      renderScaleTarget:
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget))
              .rpcId
    });
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

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number): void {
    // Default blend mode for non-blend-mode-aware layers
    if (renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }
  abstract draw(sliceView: SliceView): void;
}

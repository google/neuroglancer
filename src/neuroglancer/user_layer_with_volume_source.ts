/**
 * @license
 * Copyright 2018 Google Inc.
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

import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {GetVolumeOptions} from 'neuroglancer/datasource';
import {RenderLayerRole, UserLayer} from 'neuroglancer/layer';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {getAnnotationRenderOptions, UserLayerWithAnnotations, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {UserLayerWithCoordinateTransform, UserLayerWithCoordinateTransformMixin} from 'neuroglancer/user_layer_with_coordinate_transform';
import {verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';
import {RenderLayer as GenericSliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer.ts';
import {VoxelSizeSelectionWidget} from 'neuroglancer/widget/voxel_size_selection_widget';
import {vec3} from 'neuroglancer/util/geom';

const SOURCE_JSON_KEY = 'source';
const MIN_MIP_LEVEL_JSON_KEY = 'minMIPLevel';
const MAX_MIP_LEVEL_JSON_KEY = 'maxMIPLevel';

interface BaseConstructor {
  new(...args: any[]): UserLayerWithAnnotations&UserLayerWithCoordinateTransform;
}

// Only called by UserLayerWithVolumeSourceMixin in this file.
function helper<TBase extends BaseConstructor>(Base: TBase) {
  class C extends Base implements UserLayerWithVolumeSource {
    volumePath: string|undefined;
    multiscaleSource: Promise<MultiscaleVolumeChunkSource>|undefined;
    volumeOptions: GetVolumeOptions|undefined;
    mipLevelConstraints = new TrackableMIPLevelConstraints();
    voxelSizeSelectionWidget = this.registerDisposer(new VoxelSizeSelectionWidget(this.mipLevelConstraints));

    constructor(...args:any[]) {
      super(...args);
      this.registerDisposer(this.mipLevelConstraints.changed.add(this.specificationChanged.dispatch));
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.mipLevelConstraints.restoreState(specification[MIN_MIP_LEVEL_JSON_KEY], specification[MAX_MIP_LEVEL_JSON_KEY], false);
      const volumePath = this.volumePath =
          verifyObjectProperty(specification, SOURCE_JSON_KEY, verifyOptionalString);
      if (volumePath !== undefined) {
        const multiscaleSource = this.multiscaleSource = getVolumeWithStatusMessage(
            this.manager.dataSourceProvider, this.manager.chunkManager, volumePath,
            this.volumeOptions);
        multiscaleSource.then(volume => {
          if (!this.wasDisposed) {
            const staticAnnotations = volume.getStaticAnnotations && volume.getStaticAnnotations();
            if (staticAnnotations !== undefined) {
              this.annotationLayerState.value = new AnnotationLayerState({
                transform: this.transform,
                source: staticAnnotations,
                role: RenderLayerRole.DEFAULT_ANNOTATION,
                ...getAnnotationRenderOptions(this),
              });
            }
          }
        });
      }
    }

    toJSON() {
      const result = super.toJSON();
      result[SOURCE_JSON_KEY] = this.volumePath;
      result[MIN_MIP_LEVEL_JSON_KEY] = this.mipLevelConstraints.minMIPLevel.value;
      result[MAX_MIP_LEVEL_JSON_KEY] = this.mipLevelConstraints.maxMIPLevel.value;
      return result;
    }

    // Called after user layer's render layer is created
    protected setupVoxelSelectionWidget(renderlayer: GenericSliceViewRenderLayer) {
      const voxelSizePerMIPLevel: vec3[] = [];
      renderlayer.transformedSources.forEach(transformedSource => {
        voxelSizePerMIPLevel.push(transformedSource[0].source.spec.voxelSize);
      });
      this.voxelSizeSelectionWidget.setup(
        voxelSizePerMIPLevel, renderlayer.activeMinMIPLevel);
    }
  }
  return C;
}

export interface UserLayerWithVolumeSource extends UserLayerWithAnnotations,
                                                   UserLayerWithCoordinateTransform {
  volumePath: string|undefined;
  multiscaleSource: Promise<MultiscaleVolumeChunkSource>|undefined;
  mipLevelConstraints: TrackableMIPLevelConstraints;
}

/**
 * Mixin that adds a `source` property to a user layer.
 */
export function UserLayerWithVolumeSourceMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  return helper(UserLayerWithAnnotationsMixin(UserLayerWithCoordinateTransformMixin(Base)));
}

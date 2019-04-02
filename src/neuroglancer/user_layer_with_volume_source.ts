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
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {getAnnotationRenderOptions, UserLayerWithAnnotations, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {UserLayerWithCoordinateTransform, UserLayerWithCoordinateTransformMixin} from 'neuroglancer/user_layer_with_coordinate_transform';
import {verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';

const SOURCE_JSON_KEY = 'source';
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionRenderScale';

interface BaseConstructor {
  new(...args: any[]): UserLayerWithAnnotations&UserLayerWithCoordinateTransform;
}

function helper<TBase extends BaseConstructor>(Base: TBase) {
  class C extends Base implements UserLayerWithVolumeSource {
    volumePath: string|undefined;
    multiscaleSource: Promise<MultiscaleVolumeChunkSource>|undefined;
    volumeOptions: GetVolumeOptions|undefined;
    sliceViewRenderScaleHistogram = new RenderScaleHistogram();
    sliceViewRenderScaleTarget = (() => {
      const target = trackableRenderScaleTarget(1);
      target.changed.add(this.specificationChanged.dispatch);
      return target;
    })();

    restoreState(specification: any) {
      super.restoreState(specification);
      const volumePath = this.volumePath =
          verifyObjectProperty(specification, SOURCE_JSON_KEY, verifyOptionalString);
      this.sliceViewRenderScaleTarget.restoreState(
          specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY]);

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
      result[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();
      return result;
    }
  }
  return C;
}

export interface UserLayerWithVolumeSource extends UserLayerWithAnnotations,
                                                   UserLayerWithCoordinateTransform {
  volumePath: string|undefined;
  multiscaleSource: Promise<MultiscaleVolumeChunkSource>|undefined;
  sliceViewRenderScaleHistogram: RenderScaleHistogram;
  sliceViewRenderScaleTarget: TrackableValue<number>;
}

/**
 * Mixin that adds a `source` property to a user layer.
 */
export function UserLayerWithVolumeSourceMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  return helper(UserLayerWithAnnotationsMixin(UserLayerWithCoordinateTransformMixin(Base)));
}

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

import {AnnotationType, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {CoordinateTransform, makeDerivedCoordinateTransform} from 'neuroglancer/coordinate_transform';
import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {StatusMessage} from 'neuroglancer/status';
import {getAnnotationRenderOptions, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {UserLayerWithCoordinateTransformMixin} from 'neuroglancer/user_layer_with_coordinate_transform';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dVec} from 'neuroglancer/util/json';

require('./user_layer.css');

const POINTS_JSON_KEY = 'points';
const ANNOTATIONS_JSON_KEY = 'annotations';

function addPointAnnotations(annotations: LocalAnnotationSource, obj: any) {
  if (obj === undefined) {
    return;
  }
  parseArray(obj, (x, i) => {
    annotations.add({
      type: AnnotationType.POINT,
      id: '' + i,
      point: verify3dVec(x),
    });
  });
}

const VOXEL_SIZE_JSON_KEY = 'voxelSize';
const SOURCE_JSON_KEY = 'source';
const Base = UserLayerWithAnnotationsMixin(UserLayerWithCoordinateTransformMixin(UserLayer));
export class AnnotationUserLayer extends Base {
  localAnnotations = this.registerDisposer(new LocalAnnotationSource());
  voxelSize = new VoxelSize();
  sourceUrl: string|undefined;
  constructor(manager: LayerListSpecification, specification: any) {
    super(manager, specification);
    const sourceUrl = this.sourceUrl = specification[SOURCE_JSON_KEY];
    if (sourceUrl === undefined) {
      this.isReady = true;
      this.voxelSize.restoreState(specification[VOXEL_SIZE_JSON_KEY]);
      this.localAnnotations.restoreState(specification[ANNOTATIONS_JSON_KEY]);
      // Handle legacy "points" property.
      addPointAnnotations(this.localAnnotations, specification[POINTS_JSON_KEY]);
      let voxelSizeValid = false;
      const handleVoxelSizeChanged = () => {
        if (!this.voxelSize.valid && manager.voxelSize.valid) {
          vec3.copy(this.voxelSize.size, manager.voxelSize.size);
          this.voxelSize.setValid();
        }
        if (this.voxelSize.valid && voxelSizeValid === false) {
          const derivedTransform = new CoordinateTransform();
          this.registerDisposer(
              makeDerivedCoordinateTransform(derivedTransform, this.transform, (output, input) => {
                const voxelScalingMatrix = mat4.fromScaling(mat4.create(), this.voxelSize.size);
                mat4.multiply(output, input, voxelScalingMatrix);
              }));
          this.annotationLayerState.value = new AnnotationLayerState({
            transform: derivedTransform,
            source: this.localAnnotations.addRef(),
            ...getAnnotationRenderOptions(this)
          });
          voxelSizeValid = true;
        }
      };
      this.registerDisposer(this.localAnnotations.changed.add(this.specificationChanged.dispatch));
      this.registerDisposer(this.voxelSize.changed.add(this.specificationChanged.dispatch));
      this.registerDisposer(this.voxelSize.changed.add(handleVoxelSizeChanged));
      this.registerDisposer(this.manager.voxelSize.changed.add(handleVoxelSizeChanged));
      handleVoxelSizeChanged();
    } else {
      StatusMessage
          .forPromise(
              this.manager.dataSourceProvider.getAnnotationSource(
                  this.manager.chunkManager, sourceUrl),
              {
                initialMessage: `Retrieving metadata for volume ${sourceUrl}.`,
                delay: true,
                errorPrefix: `Error retrieving metadata for volume ${sourceUrl}: `,
              })
          .then(source => {
            if (this.wasDisposed) {
              return;
            }
            this.annotationLayerState.value = new AnnotationLayerState({
              transform: this.transform,
              source,
              ...getAnnotationRenderOptions(this)
            });
            this.isReady = true;
          });
    }
    this.tabs.default = 'annotations';
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'annotation';
    x[SOURCE_JSON_KEY] = this.sourceUrl;
    if (this.sourceUrl === undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotations.toJSON();
      x[VOXEL_SIZE_JSON_KEY] = this.voxelSize.toJSON();
    }
    return x;
  }
}

registerLayerType('annotation', AnnotationUserLayer);
registerLayerType('pointAnnotation', AnnotationUserLayer);

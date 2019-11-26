/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import './find_path_widget.css';

import {mat4, vec3} from 'gl-matrix';
import {AnnotationType, getAnnotationTypeHandler, Line, Point} from 'neuroglancer/annotation';
import {GraphOperationLayerState} from 'neuroglancer/graph/graph_operation_layer_state';
import {PathFindingMarkerTool} from 'neuroglancer/graph/path_finder_state';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationUserLayerWithGraph} from 'neuroglancer/segmentation_user_layer_with_graph';
import {StatusMessage} from 'neuroglancer/status';
import {SelectedGraphOperationState} from 'neuroglancer/ui/graph_multicut';
import {serializeColor} from 'neuroglancer/util/color';
import {hsvToRgb, rgbToHsv} from 'neuroglancer/util/colorspace';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {formatIntegerPoint} from 'neuroglancer/util/spatial_units';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';

const tempVec3 = vec3.create();
const hsv = new Float32Array(3);

export class FindPathWidget extends RefCounted {
  private findPathButton = document.createElement('button');

  constructor(
      private findPathGroup: Borrowed<MinimizableGroupWidget>,
      private layer: Borrowed<SegmentationUserLayerWithGraph>,
      private state: Borrowed<SelectedGraphOperationState>,
      private annotationLayer: Borrowed<GraphOperationLayerState>,
      private voxelSize: Borrowed<VoxelSize>,
      private setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.findPathGroup.element.id = 'find-path-widget';
    this.createToolbox();
    this.createPathUpdateEvent();
  }

  private get pathBetweenSupervoxels() {
    return this.layer.pathFinderState.pathBetweenSupervoxels;
  }

  private get pathAnnotationColor() {
    return this.layer.pathFinderState.pathAnnotationColor;
  }

  private createToolbox() {
    const colorWidget = this.registerDisposer(new ColorWidget(this.pathAnnotationColor));
    colorWidget.element.id = 'path-finder-color-widget';
    const selectSourceAndTargetButton = document.createElement('button');
    selectSourceAndTargetButton.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
    selectSourceAndTargetButton.title = 'Select source and target';
    selectSourceAndTargetButton.addEventListener('click', () => {
      this.layer.tool.value = new PathFindingMarkerTool(this.layer);
    });
    let pathFound = false;
    const {findPathButton} = this;
    findPathButton.textContent = '✔️';
    findPathButton.title = 'Find path';
    findPathButton.addEventListener('click', () => {
      if (!pathFound) {
        if (!this.pathBetweenSupervoxels.ready()) {
          StatusMessage.showTemporaryMessage('You must select a source and target to find a path');
        } else {
          const getSegmentSelectionFromPoint = (point: Point) => {
            return {
              segmentId: point.segments![0],
              rootId: point.segments![1],
              position: point.point
            };
          };
          this.layer.chunkedGraphLayer!
              .findPath(
                  getSegmentSelectionFromPoint(this.pathBetweenSupervoxels.source!),
                  getSegmentSelectionFromPoint(this.pathBetweenSupervoxels.target!))
              .then((centroids) => {
                pathFound = true;
                findPathButton.title = 'Path found!';
                StatusMessage.showTemporaryMessage('Path found!', 5000);
                const path: Line[] = [];
                for (let i = 0; i < centroids.length - 1; i++) {
                  const line: Line = {
                    pointA: vec3.fromValues(centroids[i][0], centroids[i][1], centroids[i][2]),
                    pointB: vec3.fromValues(
                        centroids[i + 1][0], centroids[i + 1][1], centroids[i + 1][2]),
                    id: '',
                    type: AnnotationType.LINE
                  };
                  path.push(line);
                }
                this.pathBetweenSupervoxels.setPath(path);
              });
        }
      }
    });
    const clearButton = document.createElement('button');
    clearButton.textContent = '❌';
    clearButton.title = 'Clear path';
    clearButton.addEventListener('click', () => {
      pathFound = false;
      findPathButton.title = 'Find path';
      this.pathBetweenSupervoxels.clear();
    });
    const toolbox = document.createElement('div');
    toolbox.classList.add('neuroglancer-graphoperation-toolbox');
    toolbox.appendChild(colorWidget.element);
    toolbox.appendChild(selectSourceAndTargetButton);
    toolbox.appendChild(findPathButton);
    toolbox.appendChild(clearButton);
    this.findPathGroup.appendFixedChild(toolbox);
  }

  // Rotate color by 60 degrees on color wheel (to match up with annotation line
  // segments)
  private rotateColorBy60Degrees() {
    const {pathAnnotationColor} = this;
    rgbToHsv(
        hsv, pathAnnotationColor.value[0], pathAnnotationColor.value[1],
        pathAnnotationColor.value[2]);
    hsv[0] -= 1 / 6;
    if (hsv[0] < 0) {
      hsv[0] += 1;
    }
    const rgb = hsv;
    hsvToRgb(rgb, hsv[0], hsv[1], hsv[2]);
    vec3.set(tempVec3, rgb[0], rgb[1], rgb[2]);
    return serializeColor(tempVec3);
  }

  private createPathUpdateEvent() {
    const {
      pathAnnotationColor: findPathColor,
      pathBetweenSupervoxels,
      setSpatialCoordinates,
      voxelSize,
      findPathButton
    } = this;
    const findPathLabel = document.createElement('div');
    findPathLabel.id = 'find-path-label';
    const pathSourceAndTarget = document.createElement('ul');
    pathSourceAndTarget.id = 'find-path-source-target';
    const pathUpdateEvent = () => {
      const {objectToGlobal} = this.annotationLayer;
      removeChildren(pathSourceAndTarget);

      const makePositionElement =
          (position: HTMLElement, point: vec3, transform: mat4, source: boolean) => {
            const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
            const textPrefix = (source) ? 'Source: ' : 'Target: ';
            const prefixElement = document.createElement('span');
            prefixElement.classList.add('find-path-source-or-target-prefix');
            prefixElement.textContent = textPrefix;
            const positionText =
                formatIntegerPoint(voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
            const element = document.createElement('span');
            element.classList.add('neuroglancer-multicut-voxel-coordinates-link');
            element.textContent = positionText;
            if (source) {
              element.style.color = findPathColor.toString();
              this.registerDisposer(findPathColor.changed.add(() => {
                element.style.color = findPathColor.toString();
              }));
            } else {
              element.style.color = this.rotateColorBy60Degrees();
              this.registerDisposer(findPathColor.changed.add(() => {
                element.style.color = this.rotateColorBy60Degrees();
              }));
            }
            element.title = `Center view on voxel coordinates ${positionText}.`;
            element.addEventListener('click', () => {
              setSpatialCoordinates(spatialPoint);
            });
            position.classList.add('find-path-source-or-target-item');
            position.appendChild(prefixElement);
            position.appendChild(element);
          };

      const makeAnnotationListElement = (point: vec3, transform: mat4, source: boolean) => {
        const element = document.createElement('li');
        element.title = 'Click to select, right click to recenter view.';

        const icon = document.createElement('div');
        icon.className = 'neuroglancer-annotation-icon';
        icon.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
        element.appendChild(icon);

        const position = document.createElement('div');
        position.className = 'neuroglancer-annotation-position';
        makePositionElement(position, point, transform, source);
        element.appendChild(position);

        return element;
      };

      const annotationListElementCreator = (annotation: Point, source: boolean) => {
        const point = annotation.point;
        const element = makeAnnotationListElement(point, objectToGlobal, source);
        pathSourceAndTarget.appendChild(element);
        element.addEventListener('click', () => {
          this.state.value = {id: annotation.id};
        });
        element.addEventListener('mouseup', (event: MouseEvent) => {
          if (event.button === 2) {
            vec3.transformMat4(tempVec3, point, objectToGlobal);
            setSpatialCoordinates(tempVec3);
          }
        });
      };
      if (pathBetweenSupervoxels.source) {
        annotationListElementCreator(pathBetweenSupervoxels.source, true);
      }
      if (pathBetweenSupervoxels.hasPath) {
        findPathLabel.textContent = 'Rough path between source and target found.';
        findPathButton.style.color = '#32CD32';
      } else {
        findPathLabel.textContent = 'Select a source and target to find a (very rough) path between the two.';
        findPathButton.style.color = '#000000';
      }
      if (pathBetweenSupervoxels.target) {
        annotationListElementCreator(pathBetweenSupervoxels.target, false);
      }
    };

    this.registerDisposer(pathBetweenSupervoxels.changed.add(pathUpdateEvent));
    pathUpdateEvent();
    this.findPathGroup.appendFixedChild(findPathLabel);
    this.findPathGroup.appendFlexibleChild(pathSourceAndTarget);
  }
}

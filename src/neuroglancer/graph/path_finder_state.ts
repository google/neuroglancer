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

import {vec3} from 'neuroglancer/util/geom';
import {annotationToJson, AnnotationType, Line, LocalAnnotationSource, Point, restoreAnnotation} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState} from 'neuroglancer/layer';
import {SegmentationUserLayerWithGraph} from 'neuroglancer/segmentation_user_layer_with_graph';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {WatchableRefCounted} from 'neuroglancer/trackable_value';
import {Tool} from 'neuroglancer/ui/tool';
import {serializeColor, TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

const ANNOTATION_COLOR_JSON_KEY = 'color';
const PATH_OBJECT_JSON_KEY = 'pathObject';

const PATH_SOURCE_JSON_KEY = 'source';
const PATH_TARGET_JSON_KEY = 'target';
const HAS_PATH_JSON_KEY = 'hasPath';
const ANNOTATION_PATH_JSON_KEY = 'annotationPath';

export class PathFinderState extends RefCounted {
  pathBetweenSupervoxels: PathBetweenSupervoxels;
  annotationLayerState = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
  pathAnnotationColor = new TrackableRGB(vec3.fromValues(1.0, 1.0, 0.0));
  changed = new NullarySignal();

  constructor(transform: CoordinateTransform) {
    super();
    const annotationSource = this.registerDisposer(new LocalAnnotationSource());
    this.pathBetweenSupervoxels =
        this.registerDisposer(new PathBetweenSupervoxels(annotationSource));
    this.annotationLayerState.value = new AnnotationLayerState({
      transform,
      source: annotationSource.addRef(),
      fillOpacity: trackableAlphaValue(1.0),
      color: this.pathAnnotationColor,
    });
    this.registerDisposer(this.pathBetweenSupervoxels.changed.add(this.changed.dispatch));
    this.registerDisposer(this.pathAnnotationColor.changed.add(this.changed.dispatch));
  }

  restoreState(x: any) {
    this.pathAnnotationColor.restoreState(x[ANNOTATION_COLOR_JSON_KEY]);
    this.pathBetweenSupervoxels.restoreState(x[PATH_OBJECT_JSON_KEY]);
  }

  toJSON() {
    return {
      [ANNOTATION_COLOR_JSON_KEY]: serializeColor(this.pathAnnotationColor.value),
      [PATH_OBJECT_JSON_KEY]: this.pathBetweenSupervoxels.toJSON()
    };
  }
}

class PathBetweenSupervoxels extends RefCounted {
  private _source: Point|undefined;
  private _target: Point|undefined;
  private _hasPath = false;
  changed = new NullarySignal();

  constructor(private annotationSource: LocalAnnotationSource) {
    super();
  }

  ready() {
    return this._source !== undefined && this._target !== undefined;
  }

  get source() {
    return this._source;
  }

  get target() {
    return this._target;
  }

  get hasPath() {
    return this._hasPath;
  }

  addSourceOrTarget(annotation: Point) {
    if (!this.ready()) {
      if ((!this.source) && (!this.target)) {
        // Neither source nor target exist yet
        this._source = annotation;
        this.annotationSource.add(this.source!);
        this.changed.dispatch();
      } else if (!this.target) {
        // Source already exists, target doesn't
        if (Uint64.equal(this._source!.segments![1], annotation.segments![1])) {
          this._target = annotation;
          this.annotationSource.add(this.target!);
          this.changed.dispatch();
        } else {
          StatusMessage.showTemporaryMessage('Source and target must belong to the same object');
        }
      } else {
        // Target already exists, source doesn't
        if (Uint64.equal(this._target!.segments![1], annotation.segments![1])) {
          this._source = annotation;
          // Make sure source and target are in the right order
          this.annotationSource.clear();
          this.annotationSource.add(this.source!);
          this.annotationSource.add(this.target!);
          this.changed.dispatch();
        } else {
          StatusMessage.showTemporaryMessage('Source and target must belong to the same object');
        }
      }
    }
  }

  setPath(path: Line[]) {
    if (this.ready()) {
      this.annotationSource.clear();
      const firstLine: Line =
          {pointA: this.source!.point, pointB: path[0].pointA, id: '', type: AnnotationType.LINE};
      this.annotationSource.add(firstLine);
      for (const line of path) {
        this.annotationSource.add(line);
      }
      const lastLine: Line = {
        pointA: path[path.length - 1].pointB,
        pointB: this.target!.point,
        id: '',
        type: AnnotationType.LINE
      };
      this.annotationSource.add(lastLine);
      this._hasPath = true;
      this.changed.dispatch();
    }
  }

  clear() {
    this.annotationSource.clear();
    this._source = undefined;
    this._target = undefined;
    this._hasPath = false;
    this.changed.dispatch();
  }

  restoreState(specification: any) {
    if (specification[ANNOTATION_PATH_JSON_KEY] !== undefined) {
      this.annotationSource.restoreState(
          specification[ANNOTATION_PATH_JSON_KEY].annotations, undefined);
    }
    if (specification[PATH_SOURCE_JSON_KEY] !== undefined) {
      this._source = <Point>restoreAnnotation(specification[PATH_SOURCE_JSON_KEY]);
    }
    if (specification[PATH_TARGET_JSON_KEY] !== undefined) {
      this._target = <Point>restoreAnnotation(specification[PATH_TARGET_JSON_KEY]);
    }
    if (specification[HAS_PATH_JSON_KEY] !== undefined) {
      this._hasPath = specification[HAS_PATH_JSON_KEY];
    }
    this.changed.dispatch();
  }

  toJSON() {
    const x: any = {
      [ANNOTATION_PATH_JSON_KEY]: this.annotationSource.toJSON(),
      [HAS_PATH_JSON_KEY]: this._hasPath
    };
    if (this._source) {
      x[PATH_SOURCE_JSON_KEY] = annotationToJson(this._source);
    }
    if (this._target) {
      x[PATH_TARGET_JSON_KEY] = annotationToJson(this._target);
    }
    return x;
  }
}

export class PathFindingMarkerTool extends Tool {
  constructor(private layer: SegmentationUserLayerWithGraph) {
    super();
  }

  private get pathBetweenSupervoxels() {
    return this.layer.pathFinderState.pathBetweenSupervoxels;
  }

  trigger(mouseState: MouseSelectionState) {
    if (mouseState.active) {
      const {segmentSelectionState} = this.layer.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        if (this.pathBetweenSupervoxels.ready()) {
          StatusMessage.showTemporaryMessage(
              'A source and target have already been selected.', 7000);
        } else if (!this.layer.displayState.rootSegments.has(
                       segmentSelectionState.selectedSegment)) {
          StatusMessage.showTemporaryMessage(
              'The selected supervoxel is of an unselected segment', 7000);
        } else {
          const annotation: Point = {
            id: '',
            segments: [
              segmentSelectionState.rawSelectedSegment.clone(),
              segmentSelectionState.selectedSegment.clone()
            ],
            point: vec3.transformMat4(
                vec3.create(), this.layer.manager.layerSelectedValues.mouseState.position,
                this.layer.transform.inverse),
            type: AnnotationType.POINT,
          };
          this.pathBetweenSupervoxels.addSourceOrTarget(annotation);
        }
      }
    }
  }

  get description() {
    return `select source & target supervoxel to find a path between`;
  }

  toJSON() {
    // Don't register the tool, it's not that important
    return;
  }
}

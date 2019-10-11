/**
 * @license
 * Copyright 2017 Google Inc.
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

/**
 * @file
 * Facility for showing a tooltip based on the mouse selection state.
 */

import './mouse_selection_state_tooltip.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationType, AxisAlignedBoundingBox, getAnnotationTypeHandler} from 'neuroglancer/annotation';
import {getSelectedAnnotation} from 'neuroglancer/annotation/selection';
import {CoordinateSpace} from 'neuroglancer/coordinate_transform';
import {LayerManager, MouseSelectionState} from 'neuroglancer/layer';
import {ChunkTransformParameters} from 'neuroglancer/render_coordinate_transform';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {getPositionSummary} from 'neuroglancer/ui/annotations';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {Tooltip} from 'neuroglancer/widget/tooltip';

const annotationTooltipHandlers = new Map<
    AnnotationType,
    (annotation: Annotation, element: HTMLElement, chunkTransform: ChunkTransformParameters) =>
        void>([
  [
    AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    (annotation: AxisAlignedBoundingBox, element, chunkTransform) => {
      chunkTransform;
      annotation;
      const volume = document.createElement('div');
      volume.className = 'neuroglancer-annotation-details-volume';
      // volume.textContent =
      //     formatBoundingBoxVolume(annotation.pointA, annotation.pointB, transform);
      element.appendChild(volume);
    },
  ],
]);

const TOOLTIP_DELAY = 500;

export class MouseSelectionStateTooltipManager extends RefCounted {
  private tooltip: Tooltip|undefined = undefined;

  private debouncedShowTooltip =
    this.registerCancellable(debounce(() => this.doCreateTooltip(), TOOLTIP_DELAY));

  private debouncedShowTooltip0 =
      this.registerCancellable(debounce(() => this.doCreateTooltip(), 0));


  private reference: AnnotationReference|undefined;

  private setReference(reference: AnnotationReference|undefined) {
    const existing = this.reference;
    if (existing !== undefined) {
      existing.changed.remove(this.debouncedShowTooltip0);
      existing.dispose();
      this.reference = undefined;
    }
    this.reference = reference;
    if (reference !== undefined) {
      reference.changed.add(this.debouncedShowTooltip0);
    }
  }

  constructor(
      public mouseState: MouseSelectionState, public layerManager: LayerManager,
      public coordinateSpace: WatchableValueInterface<CoordinateSpace|undefined>) {
    super();
    this.registerDisposer(mouseState.changed.add(() => this.mouseStateChanged()));
  }

  private maybeCreateTooltip() {
    const state = getSelectedAnnotation(this.mouseState, this.layerManager);
    if (state === undefined) {
      return false;
    }
    const {coordinateSpace: {value: coordinateSpace}} = this;
    if (coordinateSpace === undefined) {
      return false;
    }
    let {tooltip} = this;
    if (tooltip === undefined) {
      tooltip = this.tooltip = new Tooltip();
      tooltip.element.classList.add('neuroglancer-mouse-selection-tooltip');
    }

    const reference = state.annotationLayer.source.getReference(state.id);
    this.setReference(reference);
    if (reference.value === null) {
      return false;
    }

    removeChildren(tooltip.element);
    const header = document.createElement('div');
    header.className = 'neuroglancer-mouse-selection-tooltip-title';
    header.textContent = `${state.layer.name}`;

    const description = document.createElement('div');
    description.className = 'neuroglancer-mouse-selection-tooltip-description';

    const annotation = reference.value;

    if (annotation === undefined) {
      description.textContent = 'Loading...';
    } else {
      description.textContent = annotation.description || '';
    }

    tooltip.element.appendChild(header);
    tooltip.element.appendChild(description);

    if (annotation != null) {
      const {segments} = annotation;
      if (segments !== undefined && segments.length > 0) {
        const segmentContainer = document.createElement('div');
        segmentContainer.className = 'neuroglancer-annotation-segment-list';

        const segmentationState = state.annotationLayer.displayState.segmentationState.value;
        const segmentColorHash = segmentationState ? segmentationState.segmentColorHash : undefined;
        segments.forEach((segment, index) => {
          if (index !== 0) {
            segmentContainer.appendChild(document.createTextNode(' '));
          }
          const child = document.createElement('span');
          child.className = 'neuroglancer-annotation-segment-item';
          child.textContent = segment.toString();
          if (segmentColorHash !== undefined) {
            child.style.backgroundColor = segmentColorHash!.computeCssColor(segment);
          }
          segmentContainer.appendChild(child);
        });
        tooltip.element.appendChild(segmentContainer);
      }
      const chunkTransform = state.annotationLayer.chunkTransform.value as ChunkTransformParameters; // FIXME

      const typeHandler = getAnnotationTypeHandler(annotation.type);

      const positionElement = document.createElement('div');
      positionElement.appendChild(document.createTextNode(typeHandler.icon));
      getPositionSummary(positionElement, annotation, chunkTransform);
      positionElement.className = 'neuroglancer-mouse-selection-tooltip-annotation-corners';
      tooltip.element.appendChild(positionElement);

      const handler = annotationTooltipHandlers.get(annotation.type);
      if (handler !== undefined) {
        handler(annotation, tooltip.element, chunkTransform);
      }
    }
    return true;
  }

  private mouseStateChanged() {
    const {tooltip} = this;
    if (tooltip !== undefined) {
      tooltip.dispose();
      this.tooltip = undefined;
    }
    this.setReference(undefined);
    this.debouncedShowTooltip();
  }

  private doCreateTooltip = (() => {
    this.debouncedShowTooltip.cancel();
    this.debouncedShowTooltip0.cancel();
    const {mouseState} = this;
    if (!this.maybeCreateTooltip()) {
      const {tooltip} = this;
      if (tooltip !== undefined) {
        tooltip.dispose();
        this.tooltip = undefined;
      }
      this.setReference(undefined);
      return;
    } else {
      const tooltip = this.tooltip!;
      tooltip.updatePosition(mouseState.pageX, mouseState.pageY);
    }
  });

  disposed() {
    const {tooltip} = this;
    if (tooltip !== undefined) {
      tooltip.dispose();
      this.tooltip = undefined;
    }
    this.setReference(undefined);
    super.disposed();
  }
}

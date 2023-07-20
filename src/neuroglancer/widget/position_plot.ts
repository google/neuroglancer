/**
 * @license
 * Copyright 2017-2019 Google Inc.
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

import './position_plot.css';

import {computeCombinedLowerUpperBound, CoordinateSpace, DimensionId, getDisplayLowerUpperBounds} from 'neuroglancer/coordinate_transform';
import {Position} from 'neuroglancer/navigation_state';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {filterArrayInplace} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';


interface NormalizedDimensionBounds {
  lowerBound: number;
  upperBound: number;
  normalizedBounds: readonly{lower: number, upper: number}[];
}


function getCanvasYFromCoordinate(
    coordinate: number, lowerBound: number, upperBound: number, canvasHeight: number) {
  return Math.floor((coordinate - lowerBound) * (canvasHeight - 1) / (upperBound - lowerBound));
}

function getNormalizedDimensionBounds(
    coordinateSpace: CoordinateSpace, dimensionIndex: number,
    height: number): NormalizedDimensionBounds|undefined {
  const {boundingBoxes, bounds} = coordinateSpace;
  let [lowerBound, upperBound] = getDisplayLowerUpperBounds(bounds, dimensionIndex);
  lowerBound = Math.floor(lowerBound);
  upperBound = Math.floor(upperBound - 1);
  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) {
    return undefined;
  }
  const normalizedBounds: {lower: number, upper: number}[] = [];
  const normalize = (x: number) => {
    return getCanvasYFromCoordinate(x, lowerBound, upperBound, height);
  };
  const {rank} = coordinateSpace;
  for (const boundingBox of boundingBoxes) {
    const result = computeCombinedLowerUpperBound(boundingBox, dimensionIndex, rank);
    if (result === undefined) continue;
    result.lower = Math.max(0, normalize(result.lower));
    result.upper = Math.min(height - 1, normalize(Math.ceil(result.upper - 1)));
    normalizedBounds.push(result);
  }
  normalizedBounds.sort((a, b) => {
    const lowerDiff = a.lower - b.lower;
    if (lowerDiff !== 0) return lowerDiff;
    return b.upper - b.upper;
  });
  filterArrayInplace(normalizedBounds, (x, i) => {
    if (i === 0) return true;
    const prev = normalizedBounds[i - 1];
    return (prev.lower !== x.lower || prev.upper !== x.upper);
  });
  return {lowerBound, upperBound, normalizedBounds};
}

export class PositionPlot extends RefCounted {
  element = document.createElement('div');
  visible = true;
  dragging = new WatchableValue(false);

  tickWidth: number = this.orientation === 'column' ? 10: 5;
  barWidth: number = this.orientation === 'column' ? 15 : 10;
  barRightMargin: number = this.orientation === 'column' ? 10 : 2;
  canvasWidth: number

  constructor(
      public position: Position, public dimensionId: DimensionId,
      public orientation: 'row'|'column' = 'column') {
    super();
    this.canvasWidth = this.tickWidth + this.barWidth + this.barRightMargin;
    const plotElement = this.element;
    plotElement.classList.add('neuroglancer-position-dimension-plot');
    plotElement.dataset.orientation = orientation;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const lowerBoundElement = document.createElement('div');
    const lowerBoundContainer = document.createElement('div');
    lowerBoundContainer.appendChild(lowerBoundElement);
    const lowerBoundText = document.createTextNode('');
    lowerBoundElement.appendChild(lowerBoundText);
    const upperBoundElement = document.createElement('div');
    const hoverElement = document.createElement('div');
    lowerBoundContainer.classList.add('neuroglancer-position-dimension-plot-lowerbound');
    upperBoundElement.classList.add('neuroglancer-position-dimension-plot-upperbound');
    hoverElement.classList.add('neuroglancer-position-dimension-plot-hoverposition');
    plotElement.appendChild(lowerBoundContainer);
    plotElement.appendChild(upperBoundElement);
    plotElement.appendChild(hoverElement);
    plotElement.appendChild(canvas);

    let prevLowerBound: number|undefined, prevUpperBound: number|undefined;

    let hoverPosition: number|undefined = undefined;

    const updateView = () => {
      const coordinateSpace = this.position.coordinateSpace.value;
      const dimensionIndex = coordinateSpace.ids.indexOf(this.dimensionId);
      if (dimensionIndex === -1) return;

      let canvasHeight: number;
      if (orientation === 'column') {
        canvasHeight = 100;
        canvas.width = this.canvasWidth;
        canvas.height = canvasHeight;
        upperBoundElement.style.marginTop = `${canvasHeight - 1}px`;
      } else {
        canvasHeight = canvas.clientWidth;
        canvas.width = canvasHeight;
        canvas.height = this.canvasWidth;
      }

      const normalizedDimensionBounds =
          getNormalizedDimensionBounds(coordinateSpace, dimensionIndex, canvasHeight);
      if (normalizedDimensionBounds === undefined ||
          coordinateSpace.bounds.lowerBounds[dimensionIndex] + 1 ===
              coordinateSpace.bounds.upperBounds[dimensionIndex]) {
        this.element.style.display = 'none';
        this.visible = false;
        return;
      }
      this.visible = true;

      const {lowerBound, upperBound} = normalizedDimensionBounds;
      prevLowerBound = lowerBound;
      prevUpperBound = upperBound;
      lowerBoundText.textContent = lowerBound.toString();
      upperBoundElement.textContent = upperBound.toString();
      let canvasMargin: number;
      let lowerBoundWidth: number;
      let upperBoundWidth: number;
      if (orientation !== 'column') {
        lowerBoundWidth = lowerBoundElement.clientWidth;
        upperBoundWidth = upperBoundElement.clientWidth;
        canvasMargin = Math.max(lowerBoundWidth, upperBoundWidth) / 2;
        canvas.style.marginLeft = `${canvasMargin}px`;
        canvas.style.marginRight = `${canvasMargin}px`;
        upperBoundElement.style.position = "relative";
        upperBoundElement.style.left = `${canvasHeight + canvasMargin - upperBoundWidth / 2}px`;
        lowerBoundElement.style.marginLeft = `${canvasMargin - lowerBoundWidth / 2}px`;
      }
      this.drawDimensionBounds(canvas, ctx, normalizedDimensionBounds);
      const curPosition = this.position.value[dimensionIndex];

      const drawPositionIndicator = (pos: number|undefined, fillStyle: string) => {
        if (pos !== undefined && pos >= lowerBound && Math.floor(pos) <= upperBound) {
          ctx.fillStyle = fillStyle;
          const offset = getCanvasYFromCoordinate(pos, lowerBound, upperBound, canvasHeight);
          if (orientation === 'column') {
            ctx.fillRect(0, offset, this.canvasWidth, 1);
          } else {
            ctx.fillRect(offset, 0, 1, this.canvasWidth);
          }
          return offset;
        }
        return undefined;
      };
      const positionOffset = drawPositionIndicator(curPosition, '#f66');
      const isDragging = this.dragging.value;
      let hoverOffset = isDragging ? positionOffset : drawPositionIndicator(hoverPosition, '#66f');
      if (hoverOffset !== undefined) {
        hoverElement.textContent = (isDragging ? Math.floor(curPosition) : hoverPosition!).toString();
        const lowerBoundOffset = orientation === 'column' ? lowerBoundElement.clientHeight :
                                                            lowerBoundElement.clientWidth;
        const upperBoundOffset = orientation === 'column' ? upperBoundElement.clientHeight :
          upperBoundElement.clientWidth;
        let hoverWidth: number;
        let showLowerBound: boolean;
        let showUpperBound: boolean;
        if (orientation !== 'column') {
          hoverWidth = hoverElement.clientWidth;
          hoverOffset += canvasMargin!;
          hoverOffset -= hoverWidth / 2;
          hoverOffset = Math.max(0, hoverOffset);
          const upperLimit = canvasHeight + canvasMargin! - upperBoundOffset/2 - hoverWidth;
          showLowerBound = hoverOffset > canvasMargin! + lowerBoundOffset / 2;
          showUpperBound = hoverOffset < upperLimit;
        } else {
          showLowerBound = hoverOffset > lowerBoundOffset;
          showUpperBound = hoverOffset < canvasHeight - upperBoundOffset;
        }
        lowerBoundElement.style.visibility = showLowerBound ? '' : 'hidden';
        upperBoundElement.style.visibility = showUpperBound ? '' : 'hidden';
        hoverElement.style.display = '';
        hoverElement.style.visibility = 'visible';
        if (orientation === 'column') {
          hoverElement.style.marginTop = `${hoverOffset}px`;
        } else {
          hoverElement.style.marginLeft = `${hoverOffset}px`;
        }
      } else {
        lowerBoundElement.style.visibility = '';
        hoverElement.style.display = 'none';
        upperBoundElement.style.visibility = '';
      }
    };
    const scheduleUpdateView = this.registerCancellable(animationFrameDebounce(updateView));
    this.registerDisposer(this.position.changed.add(scheduleUpdateView));
    const getPositionFromMouseEvent = (event: MouseEvent): number|undefined => {
      if (prevLowerBound === undefined || prevUpperBound === undefined) return undefined;
      const canvasBounds = canvas.getBoundingClientRect();
      let relativeY: number;
      if (orientation === 'column') {
        relativeY = (event.clientY - canvasBounds.top) / canvasBounds.height;
      } else {
        relativeY = (event.clientX - canvasBounds.left) / canvasBounds.width;
      }
      relativeY = Math.max(0, relativeY);
      relativeY = Math.min(1, relativeY);
      return Math.round(relativeY * (prevUpperBound - prevLowerBound)) + prevLowerBound;
    };
    const setPositionFromMouse = (event: MouseEvent) => {
      const coordinateSpace = this.position.coordinateSpace.value;
      const dimensionIndex = coordinateSpace.ids.indexOf(this.dimensionId);
      if (dimensionIndex === -1) return;
      let x = getPositionFromMouseEvent(event);
      if (x === undefined) return;
      const {position} = this;
      const voxelCoordinates = position.value;
      if (!coordinateSpace.bounds.voxelCenterAtIntegerCoordinates[dimensionIndex]) {
        x += 0.5;
      }
      voxelCoordinates[dimensionIndex] = x;
      position.value = voxelCoordinates;
    };

    canvas.addEventListener('pointermove', (event: MouseEvent) => {
      const x = getPositionFromMouseEvent(event);
      hoverPosition = x;
      scheduleUpdateView();
    });
    canvas.addEventListener('pointerleave', () => {
      hoverPosition = undefined;
      scheduleUpdateView();
    });

    canvas.addEventListener('pointerdown', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      startRelativeMouseDrag(
          event,
          (newEvent: MouseEvent) => {
            if (this.wasDisposed) return;
            hoverPosition = undefined;
            setPositionFromMouse(newEvent);
            scheduleUpdateView();
            this.dragging.value = true;
          },
          () => {
            this.dragging.value = false;
            scheduleUpdateView();
          });
      setPositionFromMouse(event);
    });
    updateView();
    if (orientation === 'row') {
      canvas.style.maxWidth = '100%';
      canvas.style.justifySelf = 'stretch';
      const resizeObserver = new ResizeObserver(updateView);
      resizeObserver.observe(canvas);
    }
  }

  private drawDimensionBounds(
      canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, bounds: NormalizedDimensionBounds) {
    const {orientation} = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const {normalizedBounds} = bounds;
    const drawTick = (orientation === 'column') ? (x: number) => {
      ctx.fillRect(0, x, this.tickWidth, 1);
    } : (x: number) => {
      ctx.fillRect(x, 0, 1, this.tickWidth);
    };
    ctx.fillStyle = '#fff';
    for (const {lower, upper} of normalizedBounds) {
      drawTick(lower);
      drawTick(upper);
    }
    const length = normalizedBounds.length;
    ctx.fillStyle = '#ccc';
    for (let i = 0; i < length; ++i) {
      const {lower, upper} = normalizedBounds[i];
      const startX = Math.floor(i * this.barWidth / length);
      const width = Math.max(1, this.barWidth / length);
      if (orientation === 'column') {
        ctx.fillRect(startX + this.tickWidth, lower, width, upper + 1 - lower);
      } else {
        ctx.fillRect(lower, startX + this.tickWidth, upper + 1 - lower, width);
      }
    }
  }
}

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

import "#src/rendered_data_panel.css";
import "#src/noselect.css";

import type { Annotation } from "#src/annotation/index.js";
import { getAnnotationTypeRenderHandler } from "#src/annotation/type_handler.js";
import type { DisplayContext } from "#src/display_context.js";
import { RenderedPanel } from "#src/display_context.js";
import type { NavigationState } from "#src/navigation_state.js";
import { PickIDManager } from "#src/object_picking.js";
import {
  displayToLayerCoordinates,
  layerToDisplayCoordinates,
} from "#src/render_coordinate_transform.js";
import { StatusMessage } from "#src/status.js";
import type { TrackableValue } from "#src/trackable_value.js";
import { AutomaticallyFocusedElement } from "#src/util/automatic_focus.js";
import type { Borrowed } from "#src/util/disposable.js";
import type {
  ActionEvent,
  EventActionMap,
} from "#src/util/event_action_map.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { AXES_NAMES, kAxes, mat4, vec2, vec3 } from "#src/util/geom.js";
import { KeyboardEventBinder } from "#src/util/keyboard_bindings.js";
import * as matrix from "#src/util/matrix.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import type {
  TouchPinchInfo,
  TouchTranslateInfo,
} from "#src/util/touch_bindings.js";
import { TouchEventBinder } from "#src/util/touch_bindings.js";
import { getWheelZoomAmount } from "#src/util/wheel_zoom.js";
import type { ViewerState } from "#src/viewer_state.js";

declare let NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP: boolean | undefined;

const tempVec3 = vec3.create();

export interface RenderedDataViewerState extends ViewerState {
  inputEventMap: EventActionMap;
  pickRadius: TrackableValue<number>;
}

export class FramePickingData {
  pickIDs = new PickIDManager();
  viewportWidth = 0;
  viewportHeight = 0;
  invTransform = mat4.create();
  frameNumber = -1;
}

export class PickRequest {
  buffer: WebGLBuffer | null = null;
  glWindowX = 0;
  glWindowY = 0;
  frameNumber: number;
  sync: WebGLSync | null;
  pickRadius: number = -1;
}

const pickRequestInterval = 30;

export function getPickDiameter(pickRadius: number): number {
  return 1 + pickRadius * 2;
}

let _cachedPickRadius = -1;
let _cachedPickOffsetSequence: Uint32Array | undefined;

/**
 * Sequence of offsets into C order (pickDiamater, pickDiamater) array in order of increasing
 * distance from center.
 */
export function getPickOffsetSequence(pickRadius: number) {
  if (pickRadius === _cachedPickRadius) {
    return _cachedPickOffsetSequence!;
  }
  _cachedPickRadius = pickRadius;
  const pickDiameter = 1 + pickRadius * 2;
  const maxDist2 = pickRadius ** 2;
  const getDist2 = (x: number, y: number) =>
    (x - pickRadius) ** 2 + (y - pickRadius) ** 2;

  let offsets = new Uint32Array(pickDiameter * pickDiameter);
  let count = 0;
  for (let x = 0; x < pickDiameter; ++x) {
    for (let y = 0; y < pickDiameter; ++y) {
      if (getDist2(x, y) > maxDist2) continue;
      offsets[count++] = y * pickDiameter + x;
    }
  }
  offsets = offsets.subarray(0, count);
  offsets.sort((a, b) => {
    const x1 = a % pickDiameter;
    const y1 = (a - x1) / pickDiameter;
    const x2 = b % pickDiameter;
    const y2 = (b - x2) / pickDiameter;
    return getDist2(x1, y1) - getDist2(x2, y2);
  });
  return (_cachedPickOffsetSequence = offsets);
}

/**
 * Sets array elements to 0 that would be outside the viewport.
 *
 * @param buffer Array view, which contains a C order (pickDiameter, pickDiameter) array.
 * @param baseOffset Offset into `buffer` corresponding to (0, 0).
 * @param stride Stride between consecutive elements of the array.
 * @param glWindowX Center x position, must be integer.
 * @param glWindowY Center y position, must be integer.
 * @param viewportWidth Width of viewport in pixels.
 * @param viewportHeight Width of viewport in pixels.
 */
export function clearOutOfBoundsPickData(
  buffer: Float32Array,
  baseOffset: number,
  stride: number,
  glWindowX: number,
  glWindowY: number,
  viewportWidth: number,
  viewportHeight: number,
  pickRadius: number,
) {
  const pickDiameter = 1 + pickRadius * 2;
  const startX = glWindowX - pickRadius;
  const startY = glWindowY - pickRadius;
  if (
    startX >= 0 &&
    startY >= 0 &&
    startX + pickDiameter <= viewportWidth &&
    startY + pickDiameter <= viewportHeight
  ) {
    return;
  }
  for (let relativeY = 0; relativeY < pickDiameter; ++relativeY) {
    for (let relativeX = 0; relativeX < pickDiameter; ++relativeX) {
      const x = startX + relativeX;
      const y = startY + relativeY;
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) {
        buffer[baseOffset + (y * pickDiameter + x) * stride] = 0;
      }
    }
  }
}

export abstract class RenderedDataPanel extends RenderedPanel {
  /**
   * Current mouse position within the viewport, or -1 if the mouse is not in the viewport.
   */
  mouseX = -1;
  mouseY = -1;

  /**
   * If `false`, either the mouse is not within the viewport, or a picking request was already
   * issued for the current mouseX and mouseY after the most recent frame was rendered; when the
   * current pick requests complete, no additional pick requests will be issued.
   *
   * If `true`, a picking request was not issued for the current mouseX and mouseY due to all pick
   * buffers being in use; when a pick buffer becomes available, an additional pick request will be
   * issued.
   */
  pickRequestPending = false;

  private mouseStateForcer = () => this.blockOnPickRequest();
  protected isMovingToMousePosition: boolean = false;

  inputEventMap: EventActionMap;

  abstract navigationState: NavigationState;

  pickingData = [new FramePickingData(), new FramePickingData()];
  pickRequests = [new PickRequest(), new PickRequest()];
  pickBufferContents: Float32Array | undefined;

  /**
   * Reads pick data for the current mouse position into the currently-bound pixel pack buffer.
   */
  abstract issuePickRequest(
    glWindowX: number,
    glWindowY: number,
    pickRadius: number,
  ): void;

  /**
   * Timer id for checking if outstanding pick requests have completed.
   */
  private pickTimerId = -1;

  private cancelPickRequests() {
    const { gl } = this;
    for (const request of this.pickRequests) {
      const { sync } = request;
      if (sync !== null) {
        gl.deleteSync(sync);
      }
      request.sync = null;
    }
    clearTimeout(this.pickTimerId);
    this.pickTimerId = -1;
  }

  private issuePickRequestInternal(pickRequest: PickRequest) {
    const { gl } = this;
    let { buffer } = pickRequest;
    const pickRadius = this.viewer.pickRadius.value;
    const pickDiameter = getPickDiameter(pickRadius);
    if (buffer === null || pickRequest.pickRadius !== pickRadius) {
      pickRequest.pickRadius = pickRadius;
      buffer = pickRequest.buffer = gl.createBuffer();
      gl.bindBuffer(WebGL2RenderingContext.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(
        WebGL2RenderingContext.PIXEL_PACK_BUFFER,
        2 * 4 * 4 * pickDiameter * pickDiameter,
        WebGL2RenderingContext.STREAM_READ,
      );
    } else {
      gl.bindBuffer(WebGL2RenderingContext.PIXEL_PACK_BUFFER, buffer);
    }
    const { renderViewport } = this;
    const glWindowX =
      this.mouseX -
      renderViewport.visibleLeftFraction * renderViewport.logicalWidth;
    const glWindowY =
      renderViewport.height -
      (this.mouseY -
        renderViewport.visibleTopFraction * renderViewport.logicalHeight);
    this.issuePickRequest(glWindowX, glWindowY, pickRadius);
    pickRequest.sync = gl.fenceSync(
      WebGL2RenderingContext.SYNC_GPU_COMMANDS_COMPLETE,
      0,
    );
    pickRequest.frameNumber = this.context.frameNumber;
    pickRequest.glWindowX = glWindowX;
    pickRequest.glWindowY = glWindowY;
    gl.flush();
    // TODO(jbms): maybe call gl.flush to ensure fence is submitted
    gl.bindBuffer(WebGL2RenderingContext.PIXEL_PACK_BUFFER, null);
    if (this.pickTimerId === -1) {
      this.scheduleCheckForPickRequestCompletion();
    }
    this.pickRequestPending = false;
    const { pickRequests } = this;
    if (pickRequest !== pickRequests[0]) {
      pickRequests[1] = pickRequests[0];
      pickRequests[0] = pickRequest;
    }
    this.nextPickRequestTime = Date.now() + pickRequestInterval;
  }

  abstract completePickRequest(
    glWindowX: number,
    glWindowY: number,
    data: Float32Array,
    pickingData: FramePickingData,
    pickRadius: number,
  ): void;

  private completePickInternal(pickRequest: PickRequest) {
    const { gl } = this;
    let { pickBufferContents } = this;
    const { pickRadius } = pickRequest;
    const pickDiameter = getPickDiameter(pickRadius);
    const pickBufferContentsLength = 2 * 4 * pickDiameter * pickDiameter;
    if (
      pickBufferContents === undefined ||
      pickBufferContents.length != pickBufferContentsLength
    ) {
      pickBufferContents = this.pickBufferContents = new Float32Array(
        2 * 4 * pickDiameter * pickDiameter,
      );
    }
    gl.bindBuffer(WebGL2RenderingContext.PIXEL_PACK_BUFFER, pickRequest.buffer);
    gl.getBufferSubData(
      WebGL2RenderingContext.PIXEL_PACK_BUFFER,
      0,
      pickBufferContents,
    );
    gl.bindBuffer(WebGL2RenderingContext.PIXEL_PACK_BUFFER, null);
    const { frameNumber } = pickRequest;
    const { pickingData: pickingDataArray } = this;
    const pickingData =
      pickingDataArray[0].frameNumber === frameNumber
        ? pickingDataArray[0]
        : pickingDataArray[1];
    clearOutOfBoundsPickData(
      pickBufferContents,
      0,
      4,
      pickRequest.glWindowX,
      pickRequest.glWindowY,
      pickingData.viewportWidth,
      pickingData.viewportHeight,
      pickRadius,
    );
    this.completePickRequest(
      pickRequest.glWindowX,
      pickRequest.glWindowY,
      pickBufferContents,
      pickingData,
      pickRequest.pickRadius,
    );
  }

  private scheduleCheckForPickRequestCompletion() {
    this.pickTimerId = window.setTimeout(() => {
      this.pickTimerId = -1;
      this.checkForPickRequestCompletion();
    }, 0);
  }

  private checkForPickRequestCompletion(
    checkingBeforeDraw = false,
    block = false,
  ) {
    let currentFrameNumber = this.context.frameNumber;
    let cancelIfNotReadyFrameNumber = -1;
    if (checkingBeforeDraw) {
      --currentFrameNumber;
      cancelIfNotReadyFrameNumber = currentFrameNumber - 1;
    }
    const { pickRequests } = this;
    const { gl } = this;
    let remaining = false;
    let cancelRemaining = false;
    let available: PickRequest | undefined;
    for (const pickRequest of pickRequests) {
      const { sync } = pickRequest;
      if (sync === null) continue;
      const { frameNumber } = pickRequest;
      if (!cancelRemaining && frameNumber >= currentFrameNumber - 1) {
        if (
          block ||
          gl.getSyncParameter(sync, WebGL2RenderingContext.SYNC_STATUS) ===
            WebGL2RenderingContext.SIGNALED
        ) {
          this.completePickInternal(pickRequest);
          cancelRemaining = true;
        } else if (frameNumber !== cancelIfNotReadyFrameNumber) {
          remaining = true;
          continue;
        }
      }
      gl.deleteSync(sync);
      pickRequest.sync = null;
      available = pickRequest;
    }
    const { pickTimerId } = this;
    if (remaining && pickTimerId === -1) {
      this.scheduleCheckForPickRequestCompletion();
    } else if (!remaining && pickTimerId !== -1) {
      window.clearTimeout(pickTimerId);
      this.pickTimerId = -1;
    }
    if (
      !checkingBeforeDraw &&
      available !== undefined &&
      this.pickRequestPending &&
      this.canIssuePickRequest()
    ) {
      this.issuePickRequestInternal(available);
    }
  }

  private blockOnPickRequest() {
    if (this.pickRequestPending) {
      this.cancelPickRequests();
      this.nextPickRequestTime = 0;
      this.attemptToIssuePickRequest();
    }
    this.checkForPickRequestCompletion(
      /*checkingBeforeDraw=*/ false,
      /*block=*/ true,
    );
  }

  draw() {
    const { width, height } = this.renderViewport;
    this.checkForPickRequestCompletion(true);
    const { pickingData } = this;
    pickingData[0] = pickingData[1];
    const currentFrameNumber = this.context.frameNumber;
    const newPickingData = pickingData[1];
    newPickingData.frameNumber = currentFrameNumber;
    newPickingData.viewportWidth = width;
    newPickingData.viewportHeight = height;
    newPickingData.pickIDs.clear();
    if (!this.drawWithPicking(newPickingData)) {
      newPickingData.frameNumber = -1;
      return;
    }
    // For the new frame, allow new pick requests regardless of interval since last request.
    this.nextPickRequestTime = 0;
    if (this.mouseX >= 0) {
      this.attemptToIssuePickRequest();
    }
  }

  abstract drawWithPicking(pickingData: FramePickingData): boolean;

  private nextPickRequestTime = 0;
  private pendingPickRequestTimerId = -1;

  private pendingPickRequestTimerExpired = () => {
    this.pendingPickRequestTimerId = -1;
    if (!this.pickRequestPending) return;
    this.attemptToIssuePickRequest();
  };

  private canIssuePickRequest(): boolean {
    const time = Date.now();
    const { nextPickRequestTime, pendingPickRequestTimerId } = this;
    if (time < nextPickRequestTime) {
      if (pendingPickRequestTimerId === -1) {
        this.pendingPickRequestTimerId = window.setTimeout(
          this.pendingPickRequestTimerExpired,
          nextPickRequestTime - time,
        );
      }
      return false;
    }
    return true;
  }

  private attemptToIssuePickRequest() {
    if (!this.canIssuePickRequest()) return;
    const currentFrameNumber = this.context.frameNumber;
    const { gl } = this;

    const { pickRequests } = this;

    // Try to find an available PickRequest object.

    for (const pickRequest of pickRequests) {
      const { sync } = pickRequest;
      if (sync !== null) {
        if (pickRequest.frameNumber < currentFrameNumber - 1) {
          gl.deleteSync(sync);
        } else {
          continue;
        }
      }
      this.issuePickRequestInternal(pickRequest);
      return;
    }
  }

  /**
   * Called each time the mouse position relative to the top level of the rendered viewport changes.
   */
  private updateMousePosition(mouseX: number, mouseY: number): void {
    if (mouseX === this.mouseX && mouseY === this.mouseY) {
      return;
    }
    this.mouseX = mouseX;
    this.mouseY = mouseY;
    if (mouseX < 0) {
      // Mouse moved out of the viewport.
      this.pickRequestPending = false;
      this.cancelPickRequests();
      return;
    }
    const currentFrameNumber = this.context.frameNumber;
    const pickingData = this.pickingData[1];
    if (
      pickingData.frameNumber !== currentFrameNumber ||
      this.renderViewport.width !== pickingData.viewportWidth ||
      this.renderViewport.height !== pickingData.viewportHeight
    ) {
      // Viewport size has changed since the last frame, which means a redraw is pending.  Don't
      // issue pick request now.  Once will be issued automatically after the redraw.
      return;
    }
    this.pickRequestPending = true;
    this.attemptToIssuePickRequest();
  }

  protected isMovingToMousePositionOnPick = false;

  constructor(
    context: Borrowed<DisplayContext>,
    element: HTMLElement,
    public viewer: RenderedDataViewerState,
  ) {
    super(context, element, viewer.visibility);
    this.inputEventMap = viewer.inputEventMap;

    element.classList.add("neuroglancer-rendered-data-panel");
    element.classList.add("neuroglancer-panel");
    element.classList.add("neuroglancer-noselect");
    if (
      typeof NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP !== "undefined" &&
      NEUROGLANCER_SHOW_OBJECT_SELECTION_TOOLTIP === true
    ) {
      element.title =
        "Double click to toggle display of object under mouse pointer.  Control+rightclick to pin/unpin selection.";
    }

    this.registerDisposer(new AutomaticallyFocusedElement(element));
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(
      new MouseEventBinder(element, this.inputEventMap, (event) => {
        this.onMousemove(event);
      }),
    );
    this.registerDisposer(new TouchEventBinder(element, this.inputEventMap));

    this.registerEventListener(
      element,
      "mousemove",
      this.onMousemove.bind(this),
    );
    this.registerEventListener(
      element,
      "touchstart",
      this.onTouchstart.bind(this),
    );
    this.registerEventListener(element, "mouseleave", () => this.onMouseout());
    this.registerEventListener(
      element,
      "mouseover",
      (event) => {
        if (event.target !== element) {
          this.onMouseout();
        }
      },
      /*capture=*/ true,
    );

    registerActionListener(element, "select-position", () => {
      this.viewer.selectionDetailsState.select();
    });

    registerActionListener(element, "snap", () => {
      this.navigationState.pose.snap();
    });

    registerActionListener(element, "zoom-in", () => {
      this.context.flagContinuousCameraMotion();
      this.navigationState.zoomBy(0.5);
    });

    registerActionListener(element, "zoom-out", () => {
      this.context.flagContinuousCameraMotion();
      this.navigationState.zoomBy(2.0);
    });

    registerActionListener(element, "depth-range-decrease", () => {
      this.context.flagContinuousCameraMotion();
      this.navigationState.depthRange.value *= 0.5;
    });

    registerActionListener(element, "depth-range-increase", () => {
      this.context.flagContinuousCameraMotion();
      this.navigationState.depthRange.value *= 2;
    });

    for (let axis = 0; axis < 3; ++axis) {
      const axisName = AXES_NAMES[axis];
      for (const sign of [-1, +1]) {
        const signStr = sign < 0 ? "-" : "+";
        registerActionListener(
          element,
          `rotate-relative-${axisName}${signStr}`,
          () => {
            this.context.flagContinuousCameraMotion();
            this.navigationState.pose.rotateRelative(kAxes[axis], sign * 0.1);
          },
        );
        const tempOffset = vec3.create();
        registerActionListener(element, `${axisName}${signStr}`, () => {
          this.context.flagContinuousCameraMotion();
          const { navigationState } = this;
          const offset = tempOffset;
          offset[0] = 0;
          offset[1] = 0;
          offset[2] = 0;
          offset[axis] = sign;
          navigationState.pose.translateVoxelsRelative(offset);
        });
      }
    }

    registerActionListener(
      element,
      "zoom-via-wheel",
      (event: ActionEvent<WheelEvent>) => {
        this.context.flagContinuousCameraMotion();
        const e = event.detail;
        this.onMousemove(e, false);
        this.zoomByMouse(getWheelZoomAmount(e));
      },
    );

    registerActionListener(
      element,
      "adjust-depth-range-via-wheel",
      (event: ActionEvent<WheelEvent>) => {
        this.context.flagContinuousCameraMotion();
        const e = event.detail;
        this.navigationState.depthRange.value *= getWheelZoomAmount(e);
      },
    );

    registerActionListener(
      element,
      "translate-via-mouse-drag",
      (e: ActionEvent<MouseEvent>) => {
        startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
          this.context.flagContinuousCameraMotion();
          this.translateByViewportPixels(deltaX, deltaY);
        });
      },
    );

    registerActionListener(
      element,
      "translate-in-plane-via-touchtranslate",
      (e: ActionEvent<TouchTranslateInfo>) => {
        this.context.flagContinuousCameraMotion();
        const { detail } = e;
        this.translateByViewportPixels(detail.deltaX, detail.deltaY);
      },
    );

    registerActionListener(
      element,
      "translate-z-via-touchtranslate",
      (e: ActionEvent<TouchTranslateInfo>) => {
        this.context.flagContinuousCameraMotion();
        const { detail } = e;
        const { navigationState } = this;
        const offset = tempVec3;
        offset[0] = 0;
        offset[1] = 0;
        offset[2] = detail.deltaY + detail.deltaX;
        navigationState.pose.translateVoxelsRelative(offset);
      },
    );

    for (const amount of [1, 10]) {
      registerActionListener(
        element,
        `z+${amount}-via-wheel`,
        (event: ActionEvent<WheelEvent>) => {
          this.context.flagContinuousCameraMotion();
          const e = event.detail;
          const { navigationState } = this;
          const offset = tempVec3;
          const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
          offset[0] = 0;
          offset[1] = 0;
          offset[2] = (delta > 0 ? -1 : 1) * amount;
          navigationState.pose.translateVoxelsRelative(offset);
        },
      );
    }

    registerActionListener(element, "move-to-mouse-position", () => {
      const { mouseState } = this.viewer;
      if (mouseState.updateUnconditionally()) {
        this.navigationState.position.value = mouseState.position;
      }
    });

    registerActionListener(element, "snap", () =>
      this.navigationState.pose.snap(),
    );

    registerActionListener(
      element,
      "move-annotation",
      (e: ActionEvent<MouseEvent>) => {
        const { mouseState } = this.viewer;
        const selectedAnnotationId = mouseState.pickedAnnotationId;
        const annotationLayer = mouseState.pickedAnnotationLayer;
        if (
          annotationLayer !== undefined &&
          !annotationLayer.source.readonly &&
          selectedAnnotationId !== undefined
        ) {
          e.stopPropagation();
          const annotationRef =
            annotationLayer.source.getReference(selectedAnnotationId)!;
          const ann = <Annotation>annotationRef.value;

          const handler = getAnnotationTypeRenderHandler(ann.type);
          const pickedOffset = mouseState.pickedOffset;
          const {
            chunkTransform: { value: chunkTransform },
          } = annotationLayer;
          if (chunkTransform.error !== undefined) return;
          const { layerRank } = chunkTransform;
          const repPoint = new Float32Array(layerRank);
          handler.getRepresentativePoint(
            repPoint,
            ann,
            mouseState.pickedOffset,
          );
          const totDeltaVec = vec2.set(vec2.create(), 0, 0);
          if (mouseState.updateUnconditionally()) {
            startRelativeMouseDrag(
              e.detail,
              (_event, deltaX, deltaY) => {
                vec2.add(totDeltaVec, totDeltaVec, [deltaX, deltaY]);
                const layerPoint = new Float32Array(layerRank);
                matrix.transformPoint(
                  layerPoint,
                  chunkTransform.chunkToLayerTransform,
                  layerRank + 1,
                  repPoint,
                  layerRank,
                );
                const renderPt = tempVec3;
                const { displayDimensionIndices } =
                  this.navigationState.pose.displayDimensions.value;
                layerToDisplayCoordinates(
                  renderPt,
                  layerPoint,
                  chunkTransform.modelTransform,
                  displayDimensionIndices,
                );
                this.translateDataPointByViewportPixels(
                  renderPt,
                  renderPt,
                  totDeltaVec[0],
                  totDeltaVec[1],
                );
                displayToLayerCoordinates(
                  layerPoint,
                  renderPt,
                  chunkTransform.modelTransform,
                  displayDimensionIndices,
                );
                const newPoint = new Float32Array(layerRank);
                matrix.transformPoint(
                  newPoint,
                  chunkTransform.layerToChunkTransform,
                  layerRank + 1,
                  layerPoint,
                  layerRank,
                );
                const newAnnotation = handler.updateViaRepresentativePoint(
                  ann,
                  newPoint,
                  pickedOffset,
                );
                annotationLayer.source.update(annotationRef, newAnnotation);
              },
              (_event) => {
                annotationLayer.source.commit(annotationRef);
                annotationRef.dispose();
              },
            );
          }
        }
      },
    );

    registerActionListener(element, "delete-annotation", () => {
      const { mouseState } = this.viewer;
      const selectedAnnotationId = mouseState.pickedAnnotationId;
      const annotationLayer = mouseState.pickedAnnotationLayer;
      if (
        annotationLayer !== undefined &&
        !annotationLayer.source.readonly &&
        selectedAnnotationId !== undefined
      ) {
        const ref = annotationLayer.source.getReference(selectedAnnotationId);
        try {
          annotationLayer.source.delete(ref);
        } finally {
          ref.dispose();
        }
      }
    });

    registerActionListener(element, "finish-annotation", () => {
      const selectedLayer = this.viewer.selectedLayer.layer;
      if (selectedLayer === undefined) {
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        return;
      }
      const annotationTool = userLayer.tool.value;
      if (
        !annotationTool ||
        !(
          "complete" in annotationTool &&
          typeof annotationTool.complete === "function"
        )
      ) {
        StatusMessage.showTemporaryMessage(
          `The selected layer (${JSON.stringify(
            selectedLayer.name,
          )}) does not have annotation tool with complete step.`,
        );
        return;
      }
      annotationTool.complete();
    });

    registerActionListener(element, "undo-annotation-step", () => {
      const selectedLayer = this.viewer.selectedLayer.layer;
      if (selectedLayer === undefined) {
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        return;
      }
      const annotationTool = userLayer.tool.value;
      if (
        !annotationTool ||
        !("undo" in annotationTool && typeof annotationTool.undo === "function")
      ) {
        StatusMessage.showTemporaryMessage(
          `The selected layer (${JSON.stringify(
            selectedLayer.name,
          )}) does not have annotation tool with complete step.`,
        );
        return;
      }
      annotationTool.undo();
    });

    registerActionListener(
      element,
      "zoom-via-touchpinch",
      (e: ActionEvent<TouchPinchInfo>) => {
        this.context.flagContinuousCameraMotion();
        const { detail } = e;
        this.handleMouseMove(detail.centerX, detail.centerY);
        const ratio = detail.prevDistance / detail.distance;
        if (ratio > 0.1 && ratio < 10) {
          this.zoomByMouse(ratio);
        }
      },
    );
  }

  abstract translateDataPointByViewportPixels(
    out: vec3,
    orig: vec3,
    deltaX: number,
    deltaY: number,
  ): vec3;

  onMouseout() {
    this.updateMousePosition(-1, -1);
    this.viewer.mouseState.setForcer(undefined);
  }

  abstract translateByViewportPixels(deltaX: number, deltaY: number): void;

  handleMouseMove(clientX: number, clientY: number) {
    const { element } = this;
    const bounds = element.getBoundingClientRect();
    const mouseX =
      ((clientX - bounds.left) / bounds.width) * element.offsetWidth -
      element.clientLeft;
    const mouseY =
      ((clientY - bounds.top) / bounds.height) * element.offsetHeight +
      element.clientTop;
    const { mouseState } = this.viewer;
    mouseState.pageX = clientX + window.scrollX;
    mouseState.pageY = clientY + window.scrollY;
    mouseState.setForcer(this.mouseStateForcer);
    this.updateMousePosition(mouseX, mouseY);
  }

  onMousemove(event: MouseEvent, atOnly = true) {
    const { element } = this;
    if (atOnly && event.target !== element) {
      return;
    }
    this.handleMouseMove(event.clientX, event.clientY);
  }

  onTouchstart(event: TouchEvent) {
    const { element } = this;
    if (event.target !== element || event.targetTouches.length !== 1) {
      return;
    }
    const { clientX, clientY } = event.targetTouches[0];
    this.handleMouseMove(clientX, clientY);
  }

  disposed() {
    const { mouseState } = this.viewer;
    mouseState.removeForcer(this.mouseStateForcer);
    const { gl } = this;
    this.cancelPickRequests();
    const { pendingPickRequestTimerId } = this;
    if (pendingPickRequestTimerId !== -1) {
      window.clearTimeout(pendingPickRequestTimerId);
    }
    for (const request of this.pickRequests) {
      gl.deleteBuffer(request.buffer);
    }
    super.disposed();
  }

  abstract zoomByMouse(factor: number): void;
}

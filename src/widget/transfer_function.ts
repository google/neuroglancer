/**
 * @license
 * Copyright 2023 Google Inc.
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

import "#src/widget/transfer_function.css";

import type { CoordinateSpaceCombiner } from "#src/coordinate_transform.js";
import type { DisplayContext } from "#src/display_context.js";
import { IndirectRenderedPanel } from "#src/display_context.js";
import type { UserLayer } from "#src/layer/index.js";
import { Position } from "#src/navigation_state.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { makeCachedDerivedWatchableValue } from "#src/trackable_value.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  arraysEqual,
  arraysEqualWithPredicate,
  findClosestMatchInSortedArray,
} from "#src/util/array.js";
import { DATA_TYPE_SIGNED, DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { vec3, vec4 } from "#src/util/geom.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  computeInvlerp,
  computeLerp,
  parseDataTypeValue,
} from "#src/util/lerp.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { Uint64 } from "#src/util/uint64.js";
import type { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import type { Buffer } from "#src/webgl/buffer.js";
import { getMemoizedBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import {
  defineInvlerpShaderFunction,
  enableLerpShaderFunction,
} from "#src/webgl/lerp.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#src/webgl/lines.js";
import { drawQuads } from "#src/webgl/quad.js";
import { createGriddedRectangleArray } from "#src/webgl/rectangle_grid_buffer.js";
import type { ShaderCodePart, ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import type { TransferFunctionParameters } from "#src/webgl/shader_ui_controls.js";
import { setRawTextureParameters } from "#src/webgl/texture.js";
import { ColorWidget } from "#src/widget/color.js";
import {
  getUpdatedRangeAndWindowParameters,
  updateInputBoundValue,
  updateInputBoundWidth,
} from "#src/widget/invlerp.js";
import type {
  LayerControlFactory,
  LayerControlTool,
} from "#src/widget/layer_control.js";
import { PositionWidget } from "#src/widget/position_widget.js";
import { Tab } from "#src/widget/tab_view.js";

const TRANSFER_FUNCTION_PANEL_SIZE = 1024;
export const NUM_COLOR_CHANNELS = 4;
const POSITION_VALUES_PER_LINE = 4; // x1, y1, x2, y2
const CONTROL_POINT_X_GRAB_DISTANCE = TRANSFER_FUNCTION_PANEL_SIZE / 40;
const TRANSFER_FUNCTION_BORDER_WIDTH = 10;

const transferFunctionSamplerTextureUnit = Symbol(
  "transferFunctionSamplerTexture",
);

/**
 * Options to update a transfer function texture
 */
export interface LookupTableTextureOptions {
  /** A lookup table is a series of color values (0 - 255) for each index in the transfer function texture
   */
  lookupTable: LookupTable;
  /** textureUnit to update with the new transfer function texture data */
  textureUnit: number | undefined;
  /** range of the input space I, where T: I -> O. Allows for more precision in the
   * transfer function texture generation due to texture size limitations
   */
  inputRange: DataTypeInterval;
}

/**
 * Options to update a transfer function texture
 * TODO remove
 */
export interface LookupTableTextureOptionsOld {
  /** If lookupTable is defined, it will be used to update the texture directly.
   * A lookup table is a series of color values (0 - 255) for each index in the transfer function texture
   */
  lookupTable: LookupTable;
  /** If lookupTable is undefined, controlPoints will be used to generate a lookup table as a first step */
  controlPoints?: ControlPoint[];
  /** textureUnit to update with the new transfer function texture data */
  textureUnit: number | undefined;
  /** range of the input space I, where T: I -> O. Allows for more precision in the
   * transfer function texture generation due to texture size limitations
   */
  inputRange: DataTypeInterval;
}

interface CanvasPosition {
  normalizedX: number;
  normalizedY: number;
}

/**
 * Transfer functions are controlled via a set of control points
 * with an input value and an output RGBA color.
 * These control points are interpolated between to form a lookup table
 * which maps an input data value to an RGBA color.
 * Such a lookup table is used to form a texture, which can be sampled
 * from during rendering.
 */
export class ControlPoint {
  constructor(
    public inputValue: number | Uint64 = 0,
    public outputColor: vec4 = vec4.create(),
  ) {}

  /** Convert the input value to a normalized value between 0 and 1 */
  normalizedInput(range: DataTypeInterval): number {
    return computeInvlerp(range, this.inputValue);
  }

  /** Convert the input value to an integer index into the transfer function lookup texture */
  transferFunctionIndex(
    dataRange: DataTypeInterval,
    transferFunctionSize: number,
  ): number {
    return Math.floor(
      this.normalizedInput(dataRange) * (transferFunctionSize - 1),
    );
  }
  interpolateColor(other: ControlPoint, t: number): vec4 {
    const outputColor = new vec4();
    for (let i = 0; i < 4; ++i) {
      outputColor[i] = computeLerp(
        [this.outputColor[i], other.outputColor[i]],
        DataType.UINT8,
        t,
      ) as number;
    }
    return outputColor;
  }
  static copyFrom(other: ControlPoint) {
    const inputValue = other.inputValue;
    const outputColor = vec4.clone(other.outputColor);
    return new ControlPoint(inputValue, outputColor);
  }
}

// TODO (SKM does this make good sense?)
class SortedControlPoints {
  controlPoints: ControlPoint[];
  constructor(public parent: TransferFunction) {
    this.controlPoints = parent.trackable.value.controlPoints.map((point) =>
      ControlPoint.copyFrom(point),
    );
  }
  get range() {
    return this.parent.trackable.value.range;
  }
  addPoint(controlPoint: ControlPoint) {
    const { inputValue, outputColor } = controlPoint;
    const nearestPoint = this.findNearestControlPointIndex(inputValue);
    if (nearestPoint !== -1) {
      this.controlPoints[nearestPoint].inputValue = inputValue;
      this.controlPoints[nearestPoint].outputColor = outputColor;
      return;
    }
    const newPoint = new ControlPoint(inputValue, outputColor);
    this.controlPoints.push(newPoint);
    this.sort();
  }
  updatePoint(index: number, controlPoint: ControlPoint) {
    this.controlPoints[index] = controlPoint;
    this.sort();
  }
  updatePointColor(index: number, color: vec4) {
    this.controlPoints[index].outputColor = color;
  }
  findNearestControlPointIndex(inputValue: number | Uint64) {
    const controlPoint = new ControlPoint(inputValue, vec4.create());
    const valueToFind = controlPoint.normalizedInput(this.range);
    return findClosestMatchInSortedArray(
      this.controlPoints.map((point) => point.normalizedInput(this.range)),
      valueToFind,
      (a, b) => a - b,
    );
  }
  sort() {
    this.controlPoints.sort(
      (a, b) => a.normalizedInput(this.range) - b.normalizedInput(this.range),
    );
  }
}

class LookupTable {
  outputValues: Uint8Array;
  constructor(public lookupTableSize: number) {
    this.outputValues = new Uint8Array(
      lookupTableSize * NUM_COLOR_CHANNELS,
    ).fill(0);
  }

  resize(newSize: number) {
    this.lookupTableSize = newSize;
    this.outputValues = new Uint8Array(newSize * NUM_COLOR_CHANNELS).fill(0);
  }

  /**
   * Fill a lookup table with color values between control points via linear interpolation.
   * Everything before the first point is transparent,
   * everything after the last point has the color of the last point.
   *
   * @param controlPoints The control points to interpolate between
   * @param dataRange The range of the input data space
   */
  updateFromControlPoints(
    controlPoints: ControlPoint[],
    dataRange: DataTypeInterval,
  ) {
    const out = this.outputValues;
    const size = this.lookupTableSize;
    function addLookupValue(index: number, color: vec4) {
      out[index] = color[0];
      out[index + 1] = color[1];
      out[index + 2] = color[2];
      out[index + 3] = color[3];
    }
    function toTransferFunctionSpace(controlPoint: ControlPoint) {
      return controlPoint.transferFunctionIndex(dataRange, size);
    }

    // If no control points - return all transparent
    if (controlPoints.length === 0) {
      out.fill(0);
      return;
    }

    // If first control point not at 0 - fill in transparent values
    // up to the first point
    const firstInputValue = toTransferFunctionSpace(controlPoints[0]);
    if (firstInputValue > 0) {
      const transparent = vec4.fromValues(0, 0, 0, 0);
      for (let i = 0; i < firstInputValue; ++i) {
        const index = i * NUM_COLOR_CHANNELS;
        addLookupValue(index, transparent);
      }
    }

    // Interpolate between control points and fill to end with last color
    let controlPointIndex = 0;
    for (let i = firstInputValue; i < size; ++i) {
      const currentPoint = controlPoints[controlPointIndex];
      const nextPoint =
        controlPoints[
          Math.min(controlPointIndex + 1, controlPoints.length - 1)
        ];
      const lookupIndex = i * NUM_COLOR_CHANNELS;
      if (currentPoint === nextPoint) {
        addLookupValue(lookupIndex, currentPoint.outputColor);
      } else {
        const currentInputValue = toTransferFunctionSpace(currentPoint);
        const nextInputValue = toTransferFunctionSpace(nextPoint);
        const t =
          (i - currentInputValue) / (nextInputValue - currentInputValue);
        const lerpedColor = currentPoint.interpolateColor(nextPoint, t);
        addLookupValue(lookupIndex, lerpedColor);
        if (i === nextPoint.inputValue) {
          controlPointIndex++;
        }
      }
    }
  }
  static equal(a: LookupTable, b: LookupTable) {
    return arraysEqual(a.outputValues, b.outputValues);
  }
}

/**
 * Handles a linked lookup table and control points for a transfer function.
 */
class TransferFunction extends RefCounted {
  lookupTable: LookupTable;
  sortedControlPoints: SortedControlPoints;
  constructor(
    public dataType: DataType,
    public trackable: WatchableValueInterface<TransferFunctionParameters>,
  ) {
    super();
    this.lookupTable = new LookupTable(
      this.trackable.value.transferFunctionSize,
    );
    this.sortedControlPoints = new SortedControlPoints(this);
  }
  /** Supports negative indexing */
  toLookupTableIndex(controlPointIndex: number) {
    let index =
      controlPointIndex >= 0
        ? controlPointIndex
        : this.sortedControlPoints.controlPoints.length + controlPointIndex;
    return this.sortedControlPoints.controlPoints[index].transferFunctionIndex(
      this.trackable.value.range,
      this.trackable.value.transferFunctionSize,
    );
  }
  toNormalizedInput(controlPoint: ControlPoint) {
    return controlPoint.normalizedInput(this.trackable.value.range);
  }
  updateLookupTable() {
    this.lookupTable.updateFromControlPoints(
      this.sortedControlPoints.controlPoints,
    );
  }
  addPoint(controlPoint: ControlPoint) {
    this.sortedControlPoints.addPoint(controlPoint);
  }
  updatePoint(index: number, controlPoint: ControlPoint) {
    this.sortedControlPoints.updatePoint(index, controlPoint);
  }
  updatePointColor(index: number, color: vec4) {
    this.sortedControlPoints.updatePointColor(index, color);
  }
  findNearestControlPointIndex(
    normalizedInputValue: number,
    dataWindow: DataTypeInterval,
  ) {
    const absoluteValue = computeLerp(
      dataWindow,
      this.dataType,
      normalizedInputValue,
    );
    return this.sortedControlPoints.findNearestControlPointIndex(absoluteValue);
  }
  /** If a control point has neighbouring control points that are close by, select between them via match on the opacity */
  // TODO (skm) - complete this, needs check for -1 / +1 exist and distance check
  matchNeighbouringPointsByOpacity(startingIndex: number) {
    const controlPoints = this.sortedControlPoints.controlPoints;
    const startingPoint = controlPoints[startingIndex];
    const previousPoint = controlPoints[startingIndex - 1]?;
    const nextPoint = controlPoints[startingIndex + 1];
    const previousDistance = previousPoint
      ? Math.abs(previousPoint.outputColor[3] - startingPoint.outputColor[3])
      : Infinity;
    const nextDistance = nextPoint
      ? Math.abs(nextPoint.outputColor[3] - startingPoint.outputColor[3])
      : Infinity;
    if (previousDistance < nextDistance) {
      return startingIndex - 1;
    } else {
      return startingIndex + 1;
    }
  }
}

// old tf class
//   positionToIndex(position: number) {
//     let positionAsIndex = Math.floor(
//       position * (TRANSFER_FUNCTION_PANEL_SIZE - 1),
//     );
//     if (positionAsIndex < TRANSFER_FUNCTION_BORDER_WIDTH) {
//       positionAsIndex = 0;
//     }
//     if (
//       TRANSFER_FUNCTION_PANEL_SIZE - 1 - positionAsIndex <
//       TRANSFER_FUNCTION_BORDER_WIDTH
//     ) {
//       positionAsIndex = TRANSFER_FUNCTION_PANEL_SIZE - 1;
//     }
//     return positionAsIndex;
//   }
//   opacityToUint8(opacity: number) {
//     let opacityAsUint8 = floatToUint8(opacity);
//     if (opacityAsUint8 <= TRANSFER_FUNCTION_BORDER_WIDTH) {
//       opacityAsUint8 = 0;
//     } else if (opacityAsUint8 >= 255 - TRANSFER_FUNCTION_BORDER_WIDTH) {
//       opacityAsUint8 = 255;
//     }
//     return opacityAsUint8;
//   }
//   findNearestControlPointIndex(position: number) {
//     return findClosestMatchInSortedArray(
//       this.trackable.value.controlPoints.map((point) =>
//         point.toTransferFunctionIndex(
//           this.trackable.value.range,
//           TRANSFER_FUNCTION_PANEL_SIZE,
//         ),
//       ),
//       this.positionToIndex(position),
//       (a, b) => a - b,
//     );
//   }
//   grabControlPoint(position: number, opacity: number) {
//     const desiredPosition = this.positionToIndex(position);
//     const desiredOpacity = this.opacityToUint8(opacity);
//     const nearestIndex = this.findNearestControlPointIndex(position);
//     if (nearestIndex === -1) {
//       return -1;
//     }
//     const controlPoints = this.trackable.value.controlPoints;
//     const nearestPosition = controlPoints[nearestIndex].toTransferFunctionIndex(
//       this.trackable.value.range,
//       TRANSFER_FUNCTION_PANEL_SIZE,
//     );
//     if (
//       Math.abs(nearestPosition - desiredPosition) >
//       CONTROL_POINT_X_GRAB_DISTANCE
//     ) {
//       return -1;
//     }

//     // If points are nearby in X space, use Y space to break ties
//     const nextPosition = controlPoints[
//       nearestIndex + 1
//     ]?.toTransferFunctionIndex(
//       this.trackable.value.range,
//       TRANSFER_FUNCTION_PANEL_SIZE,
//     );
//     const nextDistance =
//       nextPosition !== undefined
//         ? Math.abs(nextPosition - desiredPosition)
//         : CONTROL_POINT_X_GRAB_DISTANCE + 1;
//     const previousPosition = controlPoints[
//       nearestIndex - 1
//     ]?.toTransferFunctionIndex(
//       this.trackable.value.range,
//       TRANSFER_FUNCTION_PANEL_SIZE,
//     );
//     const previousDistance =
//       previousPosition !== undefined
//         ? Math.abs(previousPosition - desiredPosition)
//         : CONTROL_POINT_X_GRAB_DISTANCE + 1;
//     const possibleValues: [number, number][] = [];
//     if (nextDistance <= CONTROL_POINT_X_GRAB_DISTANCE) {
//       possibleValues.push([
//         nearestIndex + 1,
//         Math.abs(
//           controlPoints[nearestIndex + 1].outputColor[3] - desiredOpacity,
//         ),
//       ]);
//     }
//     if (previousDistance <= CONTROL_POINT_X_GRAB_DISTANCE) {
//       possibleValues.push([
//         nearestIndex - 1,
//         Math.abs(
//           controlPoints[nearestIndex - 1].outputColor[3] - desiredOpacity,
//         ),
//       ]);
//     }
//     possibleValues.push([
//       nearestIndex,
//       Math.abs(controlPoints[nearestIndex].outputColor[3] - desiredOpacity),
//     ]);
//     possibleValues.sort((a, b) => a[1] - b[1]);
//     return possibleValues[0][0];
//   }
//   addPoint(position: number, opacity: number, color: vec3) {
//     const colorAsUint8 = vec3.fromValues(
//       floatToUint8(color[0]),
//       floatToUint8(color[1]),
//       floatToUint8(color[2]),
//     );
//     const opacityAsUint8 = this.opacityToUint8(opacity);
//     const controlPoints = this.trackable.value.controlPoints;
//     const positionAsIndex = this.positionToIndex(position);
//     const existingIndex = controlPoints.findIndex(
//       (point) => point.inputValue === positionAsIndex,
//     );
//     if (existingIndex !== -1) {
//       controlPoints.splice(existingIndex, 1);
//     }
//     controlPoints.push({
//       inputValue: positionAsIndex,
//       outputColor: vec4.fromValues(
//         colorAsUint8[0],
//         colorAsUint8[1],
//         colorAsUint8[2],
//         opacityAsUint8,
//       ),
//     });
//     controlPoints.sort((a, b) => a.inputValue - b.inputValue);
//   }
//   lookupTableFromControlPoints() {
//     const { lookupTable } = this;
//     const { controlPoints } = this.trackable.value;
//     lerpBetweenControlPoints(lookupTable, controlPoints);
//   }
//   updatePoint(index: number, position: number, opacity: number) {
//     const { controlPoints } = this.trackable.value;
//     const positionAsIndex = this.positionToIndex(position);
//     const opacityAsUint8 = this.opacityToUint8(opacity);
//     const color = controlPoints[index].outputColor;
//     controlPoints[index] = {
//       inputValue: positionAsIndex,
//       outputColor: vec4.fromValues(
//         color[0],
//         color[1],
//         color[2],
//         opacityAsUint8,
//       ),
//     };
//     const exsitingPositions = new Set<number>();
//     let positionToFind = positionAsIndex;
//     for (const point of controlPoints) {
//       if (exsitingPositions.has(point.inputValue)) {
//         positionToFind = positionToFind === 0 ? 1 : positionToFind - 1;
//         controlPoints[index].inputValue = positionToFind;
//         break;
//       }
//       exsitingPositions.add(point.inputValue);
//     }
//     controlPoints.sort((a, b) => a.inputValue - b.inputValue);
//     const newControlPointIndex = controlPoints.findIndex(
//       (point) => point.inputValue === positionToFind,
//     );
//     return newControlPointIndex;
//   }
//   setPointColor(index: number, color: vec3) {
//     const { controlPoints } = this.trackable.value;
//     const colorAsUint8 = vec3.fromValues(
//       floatToUint8(color[0]),
//       floatToUint8(color[1]),
//       floatToUint8(color[2]),
//     );
//     controlPoints[index].outputColor = vec4.fromValues(
//       colorAsUint8[0],
//       colorAsUint8[1],
//       colorAsUint8[2],
//       controlPoints[index].outputColor[3],
//     );
//   }
// }

/**
 * Convert a [0, 1] float to a uint8 value between 0 and 255
 * TODO (SKM) belong here? Maybe utils?
 */
export function floatToUint8(float: number) {
  return Math.min(255, Math.max(Math.round(float * 255), 0));
}

/**
 * Represent the underlying transfer function lookup table as a texture
 * TODO(skm) consider if height can be used for more efficiency
 */
export class LookupTableTexture extends RefCounted {
  texture: WebGLTexture | null = null;
  width: number;
  height = 1;
  private priorOptions: LookupTableTextureOptions | undefined = undefined;

  constructor(public gl: GL | null) {
    super();
  }

  /**
   * Compare the existing options to the new options to determine if the texture needs to be updated
   */
  optionsEqual(
    existingOptions: LookupTableTextureOptions | undefined,
    newOptions: LookupTableTextureOptions,
  ) {
    if (existingOptions === undefined) return false;
    let lookupTableEqual = true;
    if (
      existingOptions.lookupTable !== undefined &&
      newOptions.lookupTable !== undefined
    ) {
      lookupTableEqual = LookupTable.equal(
        existingOptions.lookupTable,
        newOptions.lookupTable,
      );
    }
    // let controlPointsEqual = true;
    // if (
    //   existingOptions.controlPoints !== undefined &&
    //   newOptions.controlPoints !== undefined
    // ) {
    //   controlPointsEqual = arraysEqualWithPredicate(
    //     existingOptions.controlPoints,
    //     newOptions.controlPoints,
    //     (a, b) =>
    //       a.inputValue === b.inputValue &&
    //       arraysEqual(a.outputColor, b.outputColor),
    //   );
    // }
    const textureUnitEqual =
      existingOptions.textureUnit === newOptions.textureUnit;

    return lookupTableEqual && textureUnitEqual;
  }

  updateAndActivate(options: LookupTableTextureOptions) {
    const { gl } = this;
    if (gl === null) return;
    let { texture } = this;

    // Verify input
    // if (
    //   options.lookupTable === undefined &&
    //   options.controlPoints === undefined
    // ) {
    //   throw new Error(
    //     "Either lookupTable or controlPoints must be defined for transfer function texture",
    //   );
    // }

    function activateAndBindTexture(gl: GL, textureUnit: number | undefined) {
      if (textureUnit === undefined) {
        throw new Error(
          "Texture unit must be defined for transfer function texture",
        );
      }
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    }

    // If the texture is already up to date, just bind and activate it
    if (texture !== null && this.optionsEqual(this.priorOptions, options)) {
      activateAndBindTexture(gl, options.textureUnit);
      return;
    }
    // If the texture has not been created yet, create it
    if (texture === null) {
      texture = this.texture = gl.createTexture();
    }
    // Update the texture
    activateAndBindTexture(gl, options.textureUnit);
    setRawTextureParameters(gl);
    let lookupTable = options.lookupTable;
    // if (lookupTable === undefined) {
    //   lookupTable = new LookupTable(options.size);
    //   lerpBetweenControlPoints(
    //     lookupTable,
    //     options.controlPoints!,
    //     options.inputRange,
    //     this.width * this.height,
    //   );
    // }
    gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      0,
      WebGL2RenderingContext.RGBA,
      this.width,
      1,
      0,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      lookupTable.outputValues,
    );

    // Update the prior options to the current options for future comparisons
    // Make a copy of the options for the purpose of comparison
    // TODO(skm) is this copy needed?
    this.priorOptions = { ...options };
    // textureUnit: options.textureUnit,
    // lookupTable: options.lookupTable,
    // // controlPoints: options.controlPoints?.map((point) =>
    // //   ControlPoint.copyFrom(point),
    // // ),
    // inputRange: options.inputRange,
  }

  disposed() {
    this.gl?.deleteTexture(this.texture);
    this.texture = null;
    this.priorOptions = undefined;
    super.disposed();
  }
}

/**
 * Display the UI canvas for the transfer function widget and
 * handle shader updates for elements of the canvas
 */
class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: LookupTableTexture;
  private textureVertexBuffer: Buffer;
  private textureVertexBufferArray: Float32Array;
  private controlPointsVertexBuffer: Buffer;
  private controlPointsPositionArray = new Float32Array();
  private controlPointsColorBuffer: Buffer;
  private controlPointsColorArray = new Float32Array();
  private linePositionBuffer: Buffer;
  private linePositionArray = new Float32Array();
  get drawOrder() {
    return 1;
  }
  transferFunction = this.registerDisposer(
    new TransferFunction(this.parent.dataType, this.parent.trackable),
  );
  controller = this.registerDisposer(
    new TransferFunctionController(
      this.element,
      this.parent.dataType,
      this.transferFunction,
      () => this.parent.trackable.value,
      (value: TransferFunctionParameters) => {
        this.parent.trackable.value = value;
      },
    ),
  );
  constructor(public parent: TransferFunctionWidget) {
    super(parent.display, document.createElement("div"), parent.visibility);
    const { element, gl } = this;
    element.classList.add("neuroglancer-transfer-function-panel");
    this.textureVertexBufferArray = createGriddedRectangleArray(
      TRANSFER_FUNCTION_PANEL_SIZE,
    );
    this.texture = this.registerDisposer(new LookupTableTexture(gl));

    function createBuffer(dataArray: Float32Array) {
      return getMemoizedBuffer(
        gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => dataArray,
      ).value;
    }
    this.textureVertexBuffer = this.registerDisposer(
      createBuffer(this.textureVertexBufferArray),
    );
    this.controlPointsVertexBuffer = this.registerDisposer(
      createBuffer(this.controlPointsPositionArray),
    );
    this.controlPointsColorBuffer = this.registerDisposer(
      createBuffer(this.controlPointsColorArray),
    );
    this.linePositionBuffer = this.registerDisposer(
      createBuffer(this.linePositionArray),
    );
  }

  updateTransferFunctionPointsAndLines() {
    // Normalize position to [-1, 1] for shader (x axis)
    function normalizePosition(position: number) {
      return (position / (TRANSFER_FUNCTION_PANEL_SIZE - 1)) * 2 - 1;
    }
    // Normalize opacity to [-1, 1] for shader (y axis)
    function normalizeOpacity(opacity: number) {
      return (opacity / 255) * 2 - 1;
    }
    // Normalize color to [0, 1] for shader (color channels)
    function normalizeColor(colorComponent: number) {
      return colorComponent / 255;
    }
    function addLine(
      array: Float32Array,
      index: number,
      positions: vec4,
    ): number {
      for (let i = 0; i < VERTICES_PER_LINE; ++i) {
        array[index++] = normalizePosition(positions[0]);
        array[index++] = normalizeOpacity(positions[1]);
        array[index++] = normalizePosition(positions[2]);
        array[index++] = normalizeOpacity(positions[3]);
      }
      return index;
    }

    const { transferFunction } = this;
    const { controlPoints } = transferFunction.trackable.value;
    let numLines = controlPoints.length;
    const colorChannels = NUM_COLOR_CHANNELS - 1; // ignore alpha
    const colorArray = new Float32Array(controlPoints.length * colorChannels);
    const positionArray = new Float32Array(controlPoints.length * 2);
    let positionArrayIndex = 0;
    let lineFromLeftEdge = null;
    let lineToRightEdge = null;

    // Create start and end lines if there are any control points
    if (controlPoints.length > 0) {
      // If the start point is above 0, need to draw a line from the left edge
      const firstInputValue = transferFunction.toLookupTableIndex(0);
      if (firstInputValue > 0) {
        numLines += 1;
        lineFromLeftEdge = vec4.fromValues(0, 0, firstInputValue, 0);
      }
      // If the end point is less than the transfer function length, need to draw a line to the right edge
      const finalPoint = controlPoints[controlPoints.length - 1];
      const finalInputValue = transferFunction.toLookupTableIndex(-1);
      if (finalInputValue < TRANSFER_FUNCTION_PANEL_SIZE - 1) {
        numLines += 1;
        lineToRightEdge = vec4.fromValues(
          finalInputValue,
          finalPoint.outputColor[3],
          TRANSFER_FUNCTION_PANEL_SIZE - 1,
          finalPoint.outputColor[3],
        );
      }
    }

    // Create line positions
    const linePositionArray = new Float32Array(
      numLines * VERTICES_PER_LINE * POSITION_VALUES_PER_LINE,
    );
    // Draw a vertical line up to the first control point
    if (lineFromLeftEdge !== null) {
      positionArrayIndex = addLine(
        linePositionArray,
        positionArrayIndex,
        lineFromLeftEdge,
      );
    }

    // Update points and draw lines between control points
    for (let i = 0; i < controlPoints.length; ++i) {
      const colorIndex = i * colorChannels;
      const positionIndex = i * 2;
      const { outputColor } = controlPoints[i];
      const inputValue = transferFunction.toLookupTableIndex(i);
      colorArray[colorIndex + 1] = normalizeColor(outputColor[1]);
      colorArray[colorIndex + 2] = normalizeColor(outputColor[2]);
      positionArray[positionIndex] = normalizePosition(inputValue);
      positionArray[positionIndex + 1] = normalizeOpacity(outputColor[3]);

      // Don't create a line for the last point
      if (i === controlPoints.length - 1) break;
      const linePosition = vec4.fromValues(
        inputValue,
        outputColor[3],
        transferFunction.toLookupTableIndex(i + 1),
        controlPoints[i + 1].outputColor[3],
      );
      positionArrayIndex = addLine(
        linePositionArray,
        positionArrayIndex,
        linePosition,
      );
    }

    // Draw a horizontal line out from the last point
    if (lineToRightEdge !== null) {
      addLine(linePositionArray, positionArrayIndex, lineToRightEdge);
    }

    // Update buffers
    this.controlPointsColorArray = colorArray;
    this.controlPointsPositionArray = positionArray;
    this.linePositionArray = linePositionArray;
    this.controlPointsVertexBuffer.setData(this.controlPointsPositionArray);
    this.controlPointsColorBuffer.setData(this.controlPointsColorArray);
    this.linePositionBuffer.setData(this.linePositionArray);
  }

  private transferFunctionLineShader = this.registerDisposer(
    (() => {
      const builder = new ShaderBuilder(this.gl);
      defineLineShader(builder);
      builder.addAttribute("vec4", "aLineStartEnd");
      builder.addOutputBuffer("vec4", "out_color", 0);
      builder.addVarying("float", "vColor");
      builder.setVertexMain(`
vec4 start = vec4(aLineStartEnd[0], aLineStartEnd[1], 0.0, 1.0);
vec4 end = vec4(aLineStartEnd[2], aLineStartEnd[3], 0.0, 1.0);
emitLine(start, end, 1.0);
`);
      builder.setFragmentMain(`
out_color = vec4(0.0, 1.0, 1.0, getLineAlpha());
`);
      return builder.build();
    })(),
  );

  private transferFunctionShader = this.registerDisposer(
    (() => {
      const builder = new ShaderBuilder(this.gl);
      builder.addAttribute("vec2", "aVertexPosition");
      builder.addVarying("vec2", "vTexCoord");
      builder.addOutputBuffer("vec4", "out_color", 0);
      builder.addTextureSampler(
        "sampler2D",
        "uSampler",
        transferFunctionSamplerTextureUnit,
      );
      builder.addUniform("float", "uTransferFunctionEnd");
      builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
vTexCoord = (aVertexPosition + 1.0) / 2.0;
`);
      builder.setFragmentMain(`
ivec2 texel = ivec2(floor(vTexCoord.x * uTransferFunctionEnd), 0);
out_color = texelFetch(uSampler, texel, 0);
`);
      return builder.build();
    })(),
  );

  private controlPointsShader = this.registerDisposer(
    (() => {
      const builder = new ShaderBuilder(this.gl);
      builder.addAttribute("vec2", "aVertexPosition");
      builder.addAttribute("vec3", "aVertexColor");
      builder.addVarying("vec3", "vColor");
      builder.addOutputBuffer("vec4", "out_color", 0);
      builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
gl_PointSize = 14.0;
vColor = aVertexColor;
`);
      builder.setFragmentMain(`
float vColorSum = vColor.r + vColor.g + vColor.b;
vec3 bordercolor = vec3(0.0, 0.0, 0.0);
if (vColorSum < 0.4) {
  bordercolor = vec3(1.0, 1.0, 1.0);
}
float dist = distance(gl_PointCoord, vec2(0.5, 0.5));
float alpha = smoothstep(0.25, 0.4, dist);
vec4 tempColor = vec4(mix(vColor, bordercolor, alpha), 1.0);
alpha = 1.0 - smoothstep(0.4, 0.5, dist);
out_color = tempColor * alpha;
`);
      return builder.build();
    })(),
  );

  drawIndirect() {
    const {
      transferFunctionLineShader,
      gl,
      transferFunctionShader,
      controlPointsShader,
    } = this;
    this.setGLLogicalViewport();
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.blendFunc(
      WebGL2RenderingContext.SRC_ALPHA,
      WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
    );
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.disable(WebGL2RenderingContext.STENCIL_TEST);
    {
      // Draw transfer function texture
      transferFunctionShader.bind();
      const aVertexPosition =
        transferFunctionShader.attribute("aVertexPosition");
      gl.uniform1f(
        transferFunctionShader.uniform("uTransferFunctionEnd"),
        TRANSFER_FUNCTION_PANEL_SIZE - 1,
      );
      this.textureVertexBuffer.bindToVertexAttrib(
        aVertexPosition,
        /*components=*/ 2,
        /*attributeType=*/ WebGL2RenderingContext.FLOAT,
      );
      const textureUnit = transferFunctionShader.textureUnit(
        transferFunctionSamplerTextureUnit,
      );
      this.texture.updateAndActivate({
        lookupTable: this.transferFunction.lookupTable,
        textureUnit,
        inputRange: this.transferFunction.trackable.value.range,
      });
      drawQuads(this.gl, TRANSFER_FUNCTION_PANEL_SIZE, 1);
      gl.disableVertexAttribArray(aVertexPosition);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    }
    // Draw lines and control points on top of transfer function - if there are any
    if (this.controlPointsPositionArray.length > 0) {
      const { renderViewport } = this;

      // Draw transfer function lerp indicator lines
      transferFunctionLineShader.bind();
      const aLineStartEnd =
        transferFunctionLineShader.attribute("aLineStartEnd");
      this.linePositionBuffer.bindToVertexAttrib(
        aLineStartEnd,
        /*components=*/ 4,
        /*attributeType=*/ WebGL2RenderingContext.FLOAT,
      );
      initializeLineShader(
        transferFunctionLineShader,
        {
          width: renderViewport.logicalWidth,
          height: renderViewport.logicalHeight,
        },
        /*featherWidthInPixels=*/ 1,
      );
      drawLines(
        gl,
        this.linePositionArray.length /
          (VERTICES_PER_LINE * POSITION_VALUES_PER_LINE),
        1,
      );
      gl.disableVertexAttribArray(aLineStartEnd);

      // Draw control points of the transfer function
      controlPointsShader.bind();
      const aVertexPosition = controlPointsShader.attribute("aVertexPosition");
      this.controlPointsVertexBuffer.bindToVertexAttrib(
        aVertexPosition,
        /*components=*/ 2,
        /*attributeType=*/ WebGL2RenderingContext.FLOAT,
      );
      const aVertexColor = controlPointsShader.attribute("aVertexColor");
      this.controlPointsColorBuffer.bindToVertexAttrib(
        aVertexColor,
        /*components=*/ 3,
        /*attributeType=*/ WebGL2RenderingContext.FLOAT,
      );
      gl.drawArrays(gl.POINTS, 0, this.controlPointsPositionArray.length / 2);
      gl.disableVertexAttribArray(aVertexPosition);
      gl.disableVertexAttribArray(aVertexColor);
    }
    gl.disable(WebGL2RenderingContext.BLEND);
  }
  grabControlPointNearCursor(mouseXPosition: number, mouseYPosition: number) {
    const { transferFunction, window } = this;

    const nearestControlPointIndex =
      transferFunction.findNearestControlPointIndex(mouseXPosition, window);
    if (nearestControlPointIndex === -1) {
      return nearestControlPointIndex;
    }
    const lookupTableIndex = transferFunction.toLookupTableIndex(
      nearestControlPointIndex,
    );
    // TODO(skm) this looks awkward
    const mousePositionTableIndex = Math.floor(
      computeInvlerp(
        this.range,
        computeLerp(window, this.dataType, mouseXPosition),
      ) *
        TRANSFER_FUNCTION_PANEL_SIZE -
        1,
    );
    if (
      Math.abs(lookupTableIndex - mousePositionTableIndex) >
      CONTROL_POINT_X_GRAB_DISTANCE
    ) {
      return -1;
    }
    return transferFunction.matchNeighbouringPointsByOpacity(nearestControlPointIndex);
  }
  update() {
    this.transferFunction.updateLookupTable();
    this.updateTransferFunctionPointsAndLines();
  }
  isReady() {
    return true;
  }
}

/**
 * Create the bounds on the UI range inputs for the transfer function widget
 */
function createRangeBoundInputs(
  dataType: DataType,
  model: WatchableValueInterface<TransferFunctionParameters>,
) {
  function createRangeBoundInput(endpoint: number): HTMLInputElement {
    const e = document.createElement("input");
    e.addEventListener("focus", () => {
      e.select();
    });
    e.classList.add("neuroglancer-transfer-function-widget-bound");
    e.type = "text";
    e.spellcheck = false;
    e.autocomplete = "off";
    e.title = `${
      endpoint === 0 ? "Lower" : "Upper"
    } bound for transfer function range`;
    return e;
  }

  const container = document.createElement("div");
  container.classList.add("neuroglancer-transfer-function-range-bounds");
  const inputs = [createRangeBoundInput(0), createRangeBoundInput(1)];
  for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
    const input = inputs[endpointIndex];
    input.addEventListener("input", () => {
      updateInputBoundWidth(input);
    });
    input.addEventListener("change", () => {
      const existingBounds = model.value.range;
      const intervals = { range: existingBounds, window: existingBounds };
      try {
        const value = parseDataTypeValue(dataType, input.value);
        const range = getUpdatedRangeAndWindowParameters(
          intervals,
          "window",
          endpointIndex,
          value,
          /*fitRangeInWindow=*/ true,
        ).window;
        model.value = { ...model.value, range };
      } catch {
        updateInputBoundValue(input, existingBounds[endpointIndex]);
      }
    });
  }
  container.appendChild(inputs[0]);
  container.appendChild(inputs[1]);
  return {
    container,
    inputs,
  };
}

const inputEventMap = EventActionMap.fromObject({
  "shift?+mousedown0": { action: "add-or-drag-point" },
  "shift+dblclick0": { action: "remove-point" },
  "shift?+mousedown2": { action: "change-point-color" },
});

/**
 * Controller for the transfer function widget. Handles mouse events and updates to the model.
 */
class TransferFunctionController extends RefCounted {
  private currentGrabbedControlPointIndex = -1;
  constructor(
    public element: HTMLElement,
    public dataType: DataType,
    private transferFunction: TransferFunction,
    public getModel: () => TransferFunctionParameters,
    public setModel: (value: TransferFunctionParameters) => void,
  ) {
    super();
    element.title = inputEventMap.describe();
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    registerActionListener<MouseEvent>(
      element,
      "add-or-drag-point",
      (actionEvent) => {
        const mouseEvent = actionEvent.detail;
        this.updateValue(this.addControlPoint(mouseEvent));
        startRelativeMouseDrag(mouseEvent, (newEvent: MouseEvent) => {
          this.updateValue(this.moveControlPoint(newEvent));
        });
      },
    );
    registerActionListener<MouseEvent>(
      element,
      "remove-point",
      (actionEvent) => {
        const mouseEvent = actionEvent.detail;
        const nearestIndex = this.findNearestControlPointIndex(mouseEvent);
        if (nearestIndex !== -1) {
          this.transferFunction.trackable.value.controlPoints.splice(
            nearestIndex,
            1,
          );
          this.updateValue({
            ...this.getModel(),
            controlPoints: this.transferFunction.trackable.value.controlPoints,
          });
        }
      },
    );
    registerActionListener<MouseEvent>(
      element,
      "change-point-color",
      (actionEvent) => {
        const mouseEvent = actionEvent.detail;
        const nearestIndex = this.findNearestControlPointIndex(mouseEvent);
        if (nearestIndex !== -1) {
          const color = this.transferFunction.trackable.value.color;
          this.transferFunction.setPointColor(nearestIndex, color);
          this.updateValue({
            ...this.getModel(),
            controlPoints: this.transferFunction.trackable.value.controlPoints,
          });
        }
      },
    );
  }
  updateValue(value: TransferFunctionParameters | undefined) {
    if (value === undefined) return;
    this.setModel(value);
  }
  findNearestControlPointIndex(event: MouseEvent) {
    const { normalizedX, normalizedY } = this.getControlPointPosition(
      event,
    ) as CanvasPosition;
    return this.transferFunction.grabControlPoint(normalizedX, normalizedY);
  }
  addControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    const color = this.transferFunction.trackable.value.color;
    const nearestIndex = this.findNearestControlPointIndex(event);
    if (nearestIndex !== -1) {
      this.currentGrabbedControlPointIndex = nearestIndex;
      return undefined;
    }
    const { normalizedX, normalizedY } = this.getControlPointPosition(
      event,
    ) as CanvasPosition;
    this.transferFunction.addPoint(normalizedX, normalizedY, color);
    this.currentGrabbedControlPointIndex =
      this.findNearestControlPointIndex(event);
    return {
      ...this.getModel(),
      controlPoints: this.transferFunction.trackable.value.controlPoints,
    };
  }
  moveControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    if (this.currentGrabbedControlPointIndex !== -1) {
      const position = this.getControlPointPosition(event);
      if (position === undefined) return undefined;
      const { normalizedX, normalizedY } = position;
      this.currentGrabbedControlPointIndex = this.transferFunction.updatePoint(
        this.currentGrabbedControlPointIndex,
        normalizedX,
        normalizedY,
      );
      return {
        ...this.getModel(),
        controlPoints: this.transferFunction.trackable.value.controlPoints,
      };
    }
    return undefined;
  }
  getControlPointPosition(event: MouseEvent): CanvasPosition | undefined {
    const clientRect = this.element.getBoundingClientRect();
    const normalizedX = (event.clientX - clientRect.left) / clientRect.width;
    const normalizedY = (clientRect.bottom - event.clientY) / clientRect.height;
    if (
      normalizedX < 0 ||
      normalizedX > 1 ||
      normalizedY < 0 ||
      normalizedY > 1
    )
      return undefined;
    return { normalizedX, normalizedY };
  }
}

/**
 * Widget for the transfer function. Creates the UI elements required for the transfer function.
 */
class TransferFunctionWidget extends Tab {
  private transferFunctionPanel = this.registerDisposer(
    new TransferFunctionPanel(this),
  );

  range = createRangeBoundInputs(this.dataType, this.trackable);
  constructor(
    visibility: WatchableVisibilityPriority,
    public display: DisplayContext,
    public dataType: DataType,
    public trackable: WatchableValueInterface<TransferFunctionParameters>,
  ) {
    super(visibility);
    const { element } = this;
    element.classList.add("neuroglancer-transfer-function-widget");
    element.appendChild(this.transferFunctionPanel.element);

    // Range bounds element
    element.appendChild(this.range.container);
    this.range.container.dispatchEvent(new Event("change"));

    // Color picker element
    const colorPickerDiv = document.createElement("div");
    colorPickerDiv.classList.add("neuroglancer-transfer-function-color-picker");
    const colorPicker = this.registerDisposer(
      new ColorWidget(
        makeCachedDerivedWatchableValue(
          (x: TransferFunctionParameters) => x.color,
          [trackable],
        ),
        () => vec3.fromValues(1, 1, 1),
      ),
    );
    colorPicker.element.title = "Transfer Function Color Picker";
    colorPicker.element.id = "neuroglancer-tf-color-widget";
    colorPicker.element.addEventListener("change", () => {
      trackable.value = {
        ...this.trackable.value,
        color: colorPicker.model.value,
      };
    });
    colorPicker.element.addEventListener("input", () => {
      trackable.value = {
        ...this.trackable.value,
        color: colorPicker.model.value,
      };
    });
    colorPickerDiv.appendChild(colorPicker.element);

    element.appendChild(colorPickerDiv);
    this.updateControlPointsAndDraw();
    this.registerDisposer(
      this.trackable.changed.add(() => {
        this.updateControlPointsAndDraw();
      }),
    );
    updateInputBoundValue(this.range.inputs[0], this.trackable.value.range[0]);
    updateInputBoundValue(this.range.inputs[1], this.trackable.value.range[1]);
  }
  updateView() {
    this.transferFunctionPanel.scheduleRedraw();
  }
  updateControlPointsAndDraw() {
    this.transferFunctionPanel.update();
    this.updateView();
  }
}

/**
 * Create a shader function for the transfer function to grab the nearest lookup table value
 */
export function defineTransferFunctionShader(
  builder: ShaderBuilder,
  name: string,
  dataType: DataType,
  channel: number[],
) {
  builder.addUniform("highp float", `uTransferFunctionEnd_${name}`);
  builder.addTextureSampler(
    "sampler2D",
    `uTransferFunctionSampler_${name}`,
    `TransferFunction.${name}`,
  );
  const invlerpShaderCode = defineInvlerpShaderFunction(
    builder,
    name,
    dataType,
    true,
  ) as ShaderCodePart[];
  const shaderType = getShaderType(dataType);
  // Use ${name}_ to avoid name collisions with other shader functions in the case of FLOAT32 dtype
  let code = `
vec4 ${name}_(float inputValue) {
  int index = clamp(int(round(inputValue * uTransferFunctionEnd_${name})), 0, int(uTransferFunctionEnd_${name}));
  return texelFetch(uTransferFunctionSampler_${name}, ivec2(index, 0), 0);
}
vec4 ${name}(${shaderType} inputValue) {
  float v = computeInvlerp(inputValue, uLerpParams_${name});
  return ${name}_(clamp(v, 0.0, 1.0));
}
vec4 ${name}() {
  return ${name}(getInterpolatedDataValue(${channel.join(",")}));
}
`;
  if (dataType !== DataType.UINT64 && dataType !== DataType.FLOAT32) {
    const scalarType = DATA_TYPE_SIGNED[dataType] ? "int" : "uint";
    code += `
vec4 ${name}(${scalarType} inputValue) {
  return ${name}(${shaderType}(inputValue));
}
`;
  }
  return [
    invlerpShaderCode[0],
    invlerpShaderCode[1],
    invlerpShaderCode[2],
    code,
  ];
}

/**
 * Create a lookup table and bind that lookup table to a shader via uniforms
 */
export function enableTransferFunctionShader(
  shader: ShaderProgram,
  name: string,
  dataType: DataType,
  controlPoints: ControlPoint[],
  interval: DataTypeInterval,
) {
  const { gl } = shader;

  const texture = shader.transferFunctionTextures.get(
    `TransferFunction.${name}`,
  );
  // Create a lookup table texture if it does not exist
  if (texture === undefined) {
    shader.transferFunctionTextures.set(
      `TransferFunction.${name}`,
      new TransferFunctionTexture(gl),
    );
  }
  shader.bindAndUpdateTransferFunctionTexture(
    `TransferFunction.${name}`,
    controlPoints,
  );

  // Bind the length of the lookup table to the shader as a uniform
  gl.uniform1f(
    shader.uniform(`uTransferFunctionEnd_${name}`),
    TRANSFER_FUNCTION_LENGTH - 1,
  );

  // Use the lerp shader function to grab an index into the lookup table
  enableLerpShaderFunction(shader, name, dataType, interval);
}

/**
 * Behaviour of the transfer function widget in the tool popup window
 */
export function activateTransferFunctionTool(
  activation: ToolActivation<LayerControlTool>,
  control: TransferFunctionWidget,
) {
  activation.bindInputEventMap(inputEventMap);
  control;
}

/**
 * Create a layer control factory for the transfer function widget
 */
export function transferFunctionLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    watchableValue: WatchableValueInterface<TransferFunctionParameters>;
    defaultChannel: number[];
    channelCoordinateSpaceCombiner: CoordinateSpaceCombiner | undefined;
    dataType: DataType;
  },
): LayerControlFactory<LayerType, TransferFunctionWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {
        watchableValue,
        channelCoordinateSpaceCombiner,
        defaultChannel,
        dataType,
      } = getter(layer);

      // Setup the ability to change the channel through the UI here
      // but only if the data has multiple channels
      if (
        channelCoordinateSpaceCombiner !== undefined &&
        defaultChannel.length !== 0
      ) {
        const position = context.registerDisposer(
          new Position(channelCoordinateSpaceCombiner.combined),
        );
        const positiionWidget = context.registerDisposer(
          new PositionWidget(position, channelCoordinateSpaceCombiner, {
            copyButton: false,
          }),
        );
        context.registerDisposer(
          position.changed.add(() => {
            const value = position.value;
            const newChannel = Array.from(value, (x) => Math.floor(x));
            const oldParams = watchableValue.value;
            if (!arraysEqual(oldParams.channel, newChannel)) {
              watchableValue.value = {
                ...watchableValue.value,
                channel: newChannel,
              };
            }
          }),
        );
        const updatePosition = () => {
          const value = position.value;
          const params = watchableValue.value;
          if (!arraysEqual(params.channel, value)) {
            value.set(params.channel);
            position.changed.dispatch();
          }
        };
        updatePosition();
        context.registerDisposer(watchableValue.changed.add(updatePosition));
        options.labelContainer.appendChild(positiionWidget.element);
      }
      const control = context.registerDisposer(
        new TransferFunctionWidget(
          options.visibility,
          options.display,
          dataType,
          watchableValue,
        ),
      );
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activateTransferFunctionTool(activation, control);
    },
  };
}

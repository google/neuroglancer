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
  defaultDataTypeRange,
  parseDataTypeValue,
} from "#src/util/lerp.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import type { Uint64 } from "#src/util/uint64.js";
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

const TRANSFER_FUNCTION_PANEL_SIZE = 512;
export const NUM_COLOR_CHANNELS = 4;
const POSITION_VALUES_PER_LINE = 4; // x1, y1, x2, y2
const CONTROL_POINT_X_GRAB_DISTANCE = 0.05;
const TRANSFER_FUNCTION_BORDER_WIDTH = 0.05;

const transferFunctionSamplerTextureUnit = Symbol(
  "transferFunctionSamplerTexture",
);

const defaultTransferFunctionSizes: Record<DataType, number> = {
  [DataType.UINT8]: 0xff,
  [DataType.INT8]: 0xff,
  [DataType.UINT16]: 8192,
  [DataType.INT16]: 8192,
  [DataType.UINT32]: 8192,
  [DataType.INT32]: 8192,
  [DataType.UINT64]: 8192,
  [DataType.FLOAT32]: 8192,
};

/**
 * Options to update a lookup table texture with a direct lookup table
 */
export interface LookupTableTextureOptions {
  /** A lookup table is a series of color values (0 - 255) for each index in the transfer function texture
   */
  lookupTable: LookupTable;
  /** textureUnit to update with the new transfer function texture data */
  textureUnit: number | undefined;
}

/**
 * Options to update a transfer function texture using control points
 */
export interface ControlPointTextureOptions {
  /** controlPoints will be used to generate a lookup table as a first step */
  sortedControlPoints: SortedControlPoints;
  /** textureUnit to update with the new transfer function texture data */
  textureUnit: number | undefined;
  /** Data type of the control points */
  dataType: DataType;
  /** Lookup table number of elements*/
  lookupTableSize: number;
}

export interface TransferFunctionParameters {
  sortedControlPoints: SortedControlPoints;
  window: DataTypeInterval;
  channel: number[];
  defaultColor: vec3;
}

interface CanvasPosition {
  normalizedX: number;
  normalizedY: number;
}

/**
 * Transfer functions are controlled via a set of control points
 * with an input value and an output RGBA color (Uint8).
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
    const outputColor = vec4.create();
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

export class SortedControlPoints {
  public range: DataTypeInterval;
  constructor(
    public controlPoints: ControlPoint[] = [],
    public dataType: DataType,
    private autoComputeRange: boolean = true,
  ) {
    this.controlPoints = controlPoints;
    this.range = defaultDataTypeRange[dataType];
    this.sortAndComputeRange();
  }
  get length() {
    return this.controlPoints.length;
  }
  addPoint(controlPoint: ControlPoint) {
    const { inputValue, outputColor } = controlPoint;
    const exactMatch = this.controlPoints.findIndex(
      (point) => point.inputValue === inputValue,
    );
    if (exactMatch !== -1) {
      this.updatePointColor(exactMatch, outputColor);
    }
    const newPoint = new ControlPoint(inputValue, outputColor);
    this.controlPoints.push(newPoint);
    this.sortAndComputeRange();
  }
  removePoint(index: number) {
    this.controlPoints.splice(index, 1);
    this.computeRange();
  }
  updatePoint(index: number, controlPoint: ControlPoint): number {
    this.controlPoints[index] = controlPoint;
    const value = controlPoint.inputValue;
    const outputValue = controlPoint.outputColor;
    this.sortAndComputeRange();
    // If two points end up with the same x value, return the index of
    // the original point after sorting
    for (let i = 0; i < this.controlPoints.length; ++i) {
      if (
        this.controlPoints[i].inputValue === value &&
        arraysEqual(this.controlPoints[i].outputColor, outputValue)
      ) {
        return i;
      }
    }
    return -1;
  }
  updatePointColor(index: number, color: vec4 | vec3) {
    let outputColor = vec4.create();
    if (color.length === 3) {
      const opacity = this.controlPoints[index].outputColor[3];
      outputColor = vec4.fromValues(color[0], color[1], color[2], opacity);
    } else {
      outputColor = vec4.clone(color as vec4);
    }
    this.controlPoints[index].outputColor = outputColor;
  }
  findNearestControlPointIndex(inputValue: number | Uint64) {
    const controlPoint = new ControlPoint(inputValue, vec4.create());
    const valueToFind = controlPoint.normalizedInput(this.range);
    return this.findNearestControlPointIndexByNormalizedInput(valueToFind);
  }
  findNearestControlPointIndexByNormalizedInput(normalizedInput: number) {
    return findClosestMatchInSortedArray(
      this.controlPoints.map((point) => point.normalizedInput(this.range)),
      normalizedInput,
      (a, b) => a - b,
    );
  }
  private sortAndComputeRange() {
    this.controlPoints.sort(
      (a, b) => a.normalizedInput(this.range) - b.normalizedInput(this.range),
    );
    this.computeRange();
  }
  private computeRange() {
    if (this.autoComputeRange) {
      if (this.controlPoints.length == 0) {
        this.range = defaultDataTypeRange[this.dataType];
      }
      else if (this.controlPoints.length === 1) {
        this.range = [
          this.controlPoints[0].inputValue,
          defaultDataTypeRange[this.dataType][1],
        ] as DataTypeInterval;
      } else {
        this.range = [
          this.controlPoints[0].inputValue,
          this.controlPoints[this.controlPoints.length - 1].inputValue,
        ] as DataTypeInterval;
      }
    }
    if (this.range[0] === this.range[1]) {
      this.range = defaultDataTypeRange[this.dataType];
    }
  }
  updateRange(newRange: DataTypeInterval) {
    this.range = newRange;
    this.sortAndComputeRange();
  }
  copy() {
    const copy = new SortedControlPoints(
      [],
      this.dataType,
      this.autoComputeRange,
    );
    copy.range = this.range;
    copy.controlPoints = this.controlPoints.map((point) =>
      ControlPoint.copyFrom(point),
    );
    return copy;
  }
}

export class LookupTable {
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
  updateFromControlPoints(sortedControlPoints: SortedControlPoints) {
    const { controlPoints, range } = sortedControlPoints;
    const out = this.outputValues;
    const size = this.lookupTableSize;
    function addLookupValue(index: number, color: vec4) {
      out[index] = color[0];
      out[index + 1] = color[1];
      out[index + 2] = color[2];
      out[index + 3] = color[3];
    }
    /**
     *  Convert the control point input value to an index in the transfer function lookup table
     */
    function toTransferFunctionSpace(controlPoint: ControlPoint) {
      return controlPoint.transferFunctionIndex(range, size);
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
      const lookupIndex = i * NUM_COLOR_CHANNELS;
      if (controlPointIndex === controlPoints.length - 1) {
        addLookupValue(lookupIndex, currentPoint.outputColor);
      } else {
        const nextPoint = controlPoints[controlPointIndex + 1];
        const currentPointIndex = toTransferFunctionSpace(currentPoint);
        const nextPointIndex = toTransferFunctionSpace(nextPoint);
        const t =
          (i - currentPointIndex) / (nextPointIndex - currentPointIndex);
        const lerpedColor = currentPoint.interpolateColor(nextPoint, t);
        addLookupValue(lookupIndex, lerpedColor);
        if (i >= nextPointIndex) {
          controlPointIndex++;
        }
      }
    }
  }
  static equal(a: LookupTable, b: LookupTable) {
    return arraysEqual(a.outputValues, b.outputValues);
  }
  copy() {
    const copy = new LookupTable(this.lookupTableSize);
    copy.outputValues.set(this.outputValues);
    return copy;
  }
}

/**
 * Handles a linked lookup table and control points for a transfer function.
 */
export class TransferFunction extends RefCounted {
  lookupTable: LookupTable;
  constructor(
    public dataType: DataType,
    public trackable: WatchableValueInterface<TransferFunctionParameters>,
    size: number = defaultTransferFunctionSizes[dataType],
  ) {
    super();
    this.lookupTable = new LookupTable(size);
    this.updateLookupTable();
  }
  get sortedControlPoints() {
    return this.trackable.value.sortedControlPoints;
  }
  updateLookupTable() {
    this.lookupTable.updateFromControlPoints(this.sortedControlPoints);
  }
  addPoint(controlPoint: ControlPoint) {
    this.sortedControlPoints.addPoint(controlPoint);
  }
  updatePoint(index: number, controlPoint: ControlPoint): number {
    return this.sortedControlPoints.updatePoint(index, controlPoint);
  }
  removePoint(index: number) {
    this.sortedControlPoints.removePoint(index);
  }
  updatePointColor(index: number, color: vec4 | vec3) {
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
  get range() {
    return this.sortedControlPoints.range;
  }
  get size() {
    return this.lookupTable.lookupTableSize;
  }
}

abstract class BaseLookupTexture extends RefCounted {
  texture: WebGLTexture | null = null;
  protected width: number;
  protected height = 1;
  protected priorOptions:
    | LookupTableTextureOptions
    | ControlPointTextureOptions
    | undefined = undefined;
  constructor(public gl: GL | null) {
    super();
  }
  /**
   * Compare the existing options to the new options to determine if the texture needs to be updated
   */
  abstract optionsEqual(
    newOptions: LookupTableTextureOptions | ControlPointTextureOptions,
  ): boolean;
  abstract createLookupTable(
    options: LookupTableTextureOptions | ControlPointTextureOptions,
  ): LookupTable;
  abstract setOptions(
    options: LookupTableTextureOptions | ControlPointTextureOptions,
  ): void;
  updateAndActivate(
    options: LookupTableTextureOptions | ControlPointTextureOptions,
  ) {
    const { gl } = this;
    if (gl === null) return;
    let { texture } = this;

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
    if (texture !== null && this.optionsEqual(options)) {
      activateAndBindTexture(gl, options.textureUnit);
      return this.width * this.height;
    }
    // If the texture has not been created yet, create it
    if (texture === null) {
      texture = this.texture = gl.createTexture();
    }
    // Update the texture
    activateAndBindTexture(gl, options.textureUnit);
    setRawTextureParameters(gl);
    const lookupTable = this.createLookupTable(options);

    gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      0,
      WebGL2RenderingContext.RGBA,
      this.width,
      this.height,
      0,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      lookupTable.outputValues,
    );

    // Update the prior options to the current options for future comparisons
    this.setOptions(options);
    return this.width * this.height;
  }
  setTextureWidthAndHeightFromSize(size: number) {
    this.width = size;
  }
  disposed() {
    this.gl?.deleteTexture(this.texture);
    this.texture = null;
    this.priorOptions = undefined;
    super.disposed();
  }
}

/**
 * Represent the underlying transfer function lookup table as a texture
 */
class DirectLookupTableTexture extends BaseLookupTexture {
  texture: WebGLTexture | null = null;
  protected priorOptions: LookupTableTextureOptions | undefined = undefined;

  constructor(public gl: GL | null) {
    super(gl);
  }
  optionsEqual(newOptions: LookupTableTextureOptions) {
    const existingOptions = this.priorOptions;
    if (existingOptions === undefined) return false;
    const lookupTableEqual = LookupTable.equal(
      existingOptions.lookupTable,
      newOptions.lookupTable,
    );
    const textureUnitEqual =
      existingOptions.textureUnit === newOptions.textureUnit;
    return lookupTableEqual && textureUnitEqual;
  }
  createLookupTable(options: LookupTableTextureOptions): LookupTable {
    this.setTextureWidthAndHeightFromSize(options.lookupTable.lookupTableSize);
    return options.lookupTable;
  }
  setOptions(options: LookupTableTextureOptions) {
    this.priorOptions = {
      ...options,
      lookupTable: options.lookupTable.copy(),
    };
  }
}

export class ControlPointTexture extends BaseLookupTexture {
  protected priorOptions: ControlPointTextureOptions | undefined;
  constructor(public gl: GL | null) {
    super(gl);
  }
  optionsEqual(newOptions: ControlPointTextureOptions): boolean {
    const existingOptions = this.priorOptions;
    if (existingOptions === undefined) return false;
    const controlPointsEqual = arraysEqualWithPredicate(
      existingOptions.sortedControlPoints.controlPoints,
      newOptions.sortedControlPoints.controlPoints,
      (a, b) =>
        a.inputValue === b.inputValue &&
        arraysEqual(a.outputColor, b.outputColor),
    );
    const textureUnitEqual =
      existingOptions.textureUnit === newOptions.textureUnit;
    const dataTypeEqual = existingOptions.dataType === newOptions.dataType;
    return controlPointsEqual && textureUnitEqual && dataTypeEqual;
  }
  setOptions(options: ControlPointTextureOptions) {
    this.priorOptions = {
      ...options,
      sortedControlPoints: options.sortedControlPoints.copy(),
    };
  }
  createLookupTable(options: ControlPointTextureOptions): LookupTable {
    const lookupTableSize = this.ensureTextureSize(options.lookupTableSize);
    if (lookupTableSize === undefined) return new LookupTable(0);
    this.setTextureWidthAndHeightFromSize(lookupTableSize);
    const lookupTable = new LookupTable(lookupTableSize);
    const sortedControlPoints = options.sortedControlPoints;
    lookupTable.updateFromControlPoints(sortedControlPoints);
    return lookupTable;
  }
  ensureTextureSize(size: number) {
    const gl = this.gl;
    if (gl === null) return;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const tableTextureSize = Math.min(size, maxTextureSize);
    return tableTextureSize;
  }
}

/**
 * Display the UI canvas for the transfer function widget and
 * handle shader updates for elements of the canvas
 */
class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: DirectLookupTableTexture;
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
    new TransferFunction(
      this.parent.dataType,
      this.parent.trackable,
      TRANSFER_FUNCTION_PANEL_SIZE,
    ),
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
    this.texture = this.registerDisposer(new DirectLookupTableTexture(gl));

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
    const window = this.parent.trackable.value.window;
    function normalizeInput(input: number | Uint64) {
      const lerpedInput = computeInvlerp(window, input);
      return lerpedInput * 2 - 1;
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
        array[index++] = positions[0];
        array[index++] = positions[1];
        array[index++] = positions[2];
        array[index++] = positions[3];
      }
      return index;
    }

    const { transferFunction } = this;
    const { controlPoints } =
      transferFunction.trackable.value.sortedControlPoints;
    let numLines = Math.max(controlPoints.length - 1, 0);
    const colorChannels = NUM_COLOR_CHANNELS - 1; // ignore alpha
    const colorArray = new Float32Array(controlPoints.length * colorChannels);
    const positionArray = new Float32Array(controlPoints.length * 2);
    let positionArrayIndex = 0;
    let lineFromLeftEdge = null;
    let lineToRightEdge = null;
    const normalizedControlPoints = controlPoints.map((point) => {
      const input = normalizeInput(point.inputValue);
      const output = normalizeOpacity(point.outputColor[3]);
      return { input, output };
    });

    // Create start and end lines if there are any control points
    if (controlPoints.length > 0) {
      // Map all control points to normalized values for the shader
      // Try to find the first and last point in the window
      let firstPointIndexInWindow = null;
      let lastPointIndexInWindow = null;
      for (let i = 0; i < controlPoints.length; ++i) {
        const normalizedInput = normalizedControlPoints[i].input;
        if (normalizedInput >= -1 && normalizedInput <= 1) {
          firstPointIndexInWindow = firstPointIndexInWindow ?? i;
          lastPointIndexInWindow = i;
        }
      }
      // If there are no points in the window, everything is left or right of the window
      // Draw a single line from the left edge to the right edge if all points are left of the window
      if (firstPointIndexInWindow === null) {
        const allPointsLeftOfWindow = normalizedControlPoints[0].input > 1;
        const indexOfReferencePoint = allPointsLeftOfWindow
          ? controlPoints.length - 1
          : 0;
        numLines += 1;
        const referenceOpacity =
          normalizedControlPoints[indexOfReferencePoint].output;
        lineFromLeftEdge = vec4.fromValues(
          -1,
          referenceOpacity,
          1,
          referenceOpacity,
        );
      } else {
        const firstPointInWindow =
          normalizedControlPoints[firstPointIndexInWindow];
        // Need to draw a line from the left edge to the first control point in the window
        // Unless the first point is at the left edge
        if (firstPointInWindow.input > -1) {
          // If there is a value to the left, draw a line from the point outside the window to the first point in the window
          if (firstPointIndexInWindow > 0) {
            const pointBeforeWindow =
              normalizedControlPoints[firstPointIndexInWindow - 1];
            const interpFactor = computeInvlerp(
              [pointBeforeWindow.input, firstPointInWindow.input],
              -1,
            );
            const lineStartY = computeLerp(
              [pointBeforeWindow.output, firstPointInWindow.output],
              DataType.FLOAT32,
              interpFactor,
            ) as number;
            lineFromLeftEdge = vec4.fromValues(
              -1,
              lineStartY,
              firstPointInWindow.input,
              firstPointInWindow.output,
            );
          }
          // If the first point in the window is the leftmost point, draw a 0 line up to the point
          else {
            lineFromLeftEdge = vec4.fromValues(
              firstPointInWindow.input,
              -1,
              firstPointInWindow.input,
              firstPointInWindow.output,
            );
          }
          numLines += 1;
        }

        // Need to draw a line from the last control point in the window to the right edge
        const lastPointInWindow =
          normalizedControlPoints[lastPointIndexInWindow!];
        if (lastPointInWindow.input < 1) {
          // If there is a value to the right, draw a line from the last point in the window to the point outside the window
          if (lastPointIndexInWindow! < controlPoints.length - 1) {
            const pointAfterWindow =
              normalizedControlPoints[lastPointIndexInWindow! + 1];
            const interpFactor = computeInvlerp(
              [lastPointInWindow.input, pointAfterWindow.input],
              1,
            );
            const lineEndY = computeLerp(
              [lastPointInWindow.output, pointAfterWindow.output],
              DataType.FLOAT32,
              interpFactor,
            ) as number;
            lineToRightEdge = vec4.fromValues(
              lastPointInWindow.input,
              lastPointInWindow.output,
              1,
              lineEndY,
            );
          }
          // If the last point in the window is the rightmost point, draw a line from the point to 1
          else {
            lineToRightEdge = vec4.fromValues(
              lastPointInWindow.input,
              lastPointInWindow.output,
              1,
              lastPointInWindow.output,
            );
          }
          numLines += 1;
        }
      }
    }

    const linePositionArray = new Float32Array(
      numLines * POSITION_VALUES_PER_LINE * VERTICES_PER_LINE,
    );

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
      const inputValue = normalizedControlPoints[i].input;
      const outputValue = normalizedControlPoints[i].output;
      const { outputColor } = controlPoints[i];
      colorArray[colorIndex] = normalizeColor(outputColor[0]);
      colorArray[colorIndex + 1] = normalizeColor(outputColor[1]);
      colorArray[colorIndex + 2] = normalizeColor(outputColor[2]);
      positionArray[positionIndex] = inputValue;
      positionArray[positionIndex + 1] = outputValue;

      // Don't create a line for the last point
      if (i === controlPoints.length - 1) break;
      const lineBetweenPoints = vec4.fromValues(
        inputValue,
        outputValue,
        normalizedControlPoints[i + 1].input,
        normalizedControlPoints[i + 1].output,
      );
      positionArrayIndex = addLine(
        linePositionArray,
        positionArrayIndex,
        lineBetweenPoints,
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
  update() {
    this.transferFunction.updateLookupTable();
    this.updateTransferFunctionPointsAndLines();
  }
  isReady() {
    return true;
  }
}

/**
 * Create the bounds on the UI window inputs for the transfer function widget
 */
function createWindowBoundInputs(
  dataType: DataType,
  model: WatchableValueInterface<TransferFunctionParameters>,
) {
  function createWindowBoundInput(endpoint: number): HTMLInputElement {
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
    } window for transfer function`;
    return e;
  }

  const container = document.createElement("div");
  container.classList.add("neuroglancer-transfer-function-range-bounds");
  const inputs = [createWindowBoundInput(0), createWindowBoundInput(1)];
  for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
    const input = inputs[endpointIndex];
    input.addEventListener("input", () => {
      updateInputBoundWidth(input);
    });
    input.addEventListener("change", () => {
      const existingBounds = model.value.window;
      const intervals = { range: existingBounds, window: existingBounds };
      try {
        const value = parseDataTypeValue(dataType, input.value);
        const window = getUpdatedRangeAndWindowParameters(
          intervals,
          "window",
          endpointIndex,
          value,
          /*fitRangeInWindow=*/ true,
        ).window;
        model.value = { ...model.value, window };
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
        const nearestIndex = this.findControlPointIfNearCursor(mouseEvent);
        if (nearestIndex !== -1) {
          this.transferFunction.removePoint(nearestIndex);
          this.updateValue({
            ...this.getModel(),
            sortedControlPoints:
              this.transferFunction.trackable.value.sortedControlPoints,
          });
        }
      },
    );
    registerActionListener<MouseEvent>(
      element,
      "change-point-color",
      (actionEvent) => {
        const mouseEvent = actionEvent.detail;
        const nearestIndex = this.findControlPointIfNearCursor(mouseEvent);
        if (nearestIndex !== -1) {
          const color = this.transferFunction.trackable.value.defaultColor;
          const colorInAbsoluteValue =
            this.convertPanelSpaceColorToAbsoluteValue(color);
          this.transferFunction.updatePointColor(
            nearestIndex,
            colorInAbsoluteValue,
          );
          this.updateValue({
            ...this.getModel(),
            sortedControlPoints:
              this.transferFunction.trackable.value.sortedControlPoints,
          });
        }
      },
    );
  }
  updateValue(value: TransferFunctionParameters | undefined) {
    if (value === undefined) return;
    this.setModel(value);
  }
  convertPanelSpaceInputToAbsoluteValue(inputValue: number) {
    return computeLerp(
      this.transferFunction.trackable.value.window,
      this.dataType,
      inputValue,
    );
  }
  convertPanelSpaceColorToAbsoluteValue(color: vec3 | vec4) {
    if (color.length === 3) {
      // If color is vec3
      return vec3.fromValues(
        Math.round(color[0] * 255),
        Math.round(color[1] * 255),
        Math.round(color[2] * 255),
      );
    } else {
      // If color is vec4
      return vec4.fromValues(
        Math.round(color[0] * 255),
        Math.round(color[1] * 255),
        Math.round(color[2] * 255),
        Math.round(color[3] * 255),
      );
    }
  }
  addControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    const color = this.transferFunction.trackable.value.defaultColor;
    const nearestIndex = this.findControlPointIfNearCursor(event);
    if (nearestIndex !== -1) {
      this.currentGrabbedControlPointIndex = nearestIndex;
      return undefined;
    }
    const position = this.getControlPointPosition(event);
    if (position === undefined) return undefined;
    const { normalizedX, normalizedY } = position;
    const outputColor = vec4.fromValues(
      color[0],
      color[1],
      color[2],
      normalizedY,
    );
    this.transferFunction.addPoint(
      new ControlPoint(
        this.convertPanelSpaceInputToAbsoluteValue(normalizedX),
        this.convertPanelSpaceColorToAbsoluteValue(outputColor) as vec4,
      ),
    );
    this.currentGrabbedControlPointIndex =
      this.findControlPointIfNearCursor(event);
    return {
      ...this.getModel(),
      sortedControlPoints:
        this.transferFunction.trackable.value.sortedControlPoints,
    };
  }
  moveControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    if (this.currentGrabbedControlPointIndex !== -1) {
      const position = this.getControlPointPosition(event);
      if (position === undefined) return undefined;
      const { normalizedX, normalizedY } = position;
      const newColor =
        this.transferFunction.trackable.value.sortedControlPoints.controlPoints[
          this.currentGrabbedControlPointIndex
        ].outputColor;
      newColor[3] = Math.round(normalizedY * 255);
      this.currentGrabbedControlPointIndex = this.transferFunction.updatePoint(
        this.currentGrabbedControlPointIndex,
        new ControlPoint(
          this.convertPanelSpaceInputToAbsoluteValue(normalizedX),
          newColor,
        ),
      );
      return {
        ...this.getModel(),
        sortedControlPoints:
          this.transferFunction.trackable.value.sortedControlPoints,
      };
    }
    return undefined;
  }
  getControlPointPosition(event: MouseEvent): CanvasPosition | undefined {
    const clientRect = this.element.getBoundingClientRect();
    let normalizedX = (event.clientX - clientRect.left) / clientRect.width;
    let normalizedY = (clientRect.bottom - event.clientY) / clientRect.height;
    if (
      normalizedX < 0 ||
      normalizedX > 1 ||
      normalizedY < 0 ||
      normalizedY > 1
    )
      return undefined;

    // Near the borders of the transfer function, clamp the control point to the border
    if (normalizedX < TRANSFER_FUNCTION_BORDER_WIDTH) {
      normalizedX = 0.0;
    } else if (normalizedX > 1 - TRANSFER_FUNCTION_BORDER_WIDTH) {
      normalizedX = 1.0;
    }
    if (normalizedY < TRANSFER_FUNCTION_BORDER_WIDTH) {
      normalizedY = 0.0;
    } else if (normalizedY > 1 - TRANSFER_FUNCTION_BORDER_WIDTH) {
      normalizedY = 1.0;
    }

    return { normalizedX, normalizedY };
  }
  /**
   * Find the nearest control point to the cursor or -1 if no control point is near the cursor.
   * If multiple control points are near the cursor in X, the control point with the smallest
   * distance in the Y direction is returned.
   */
  findControlPointIfNearCursor(event: MouseEvent) {
    const { transferFunction } = this;
    const { window } = transferFunction.trackable.value;
    const numControlPoints =
      transferFunction.sortedControlPoints.controlPoints.length;
    function convertControlPointInputToPanelSpace(controlPointIndex: number) {
      if (controlPointIndex < 0 || controlPointIndex >= numControlPoints) {
        return null;
      }
      return computeInvlerp(
        window,
        transferFunction.sortedControlPoints.controlPoints[controlPointIndex]
          .inputValue,
      );
    }
    function convertControlPointOpacityToPanelSpace(controlPointIndex: number) {
      if (controlPointIndex < 0 || controlPointIndex >= numControlPoints) {
        return null;
      }
      return (
        transferFunction.sortedControlPoints.controlPoints[controlPointIndex]
          .outputColor[3] / 255
      );
    }
    const position = this.getControlPointPosition(event);
    if (position === undefined) return -1;
    const mouseXPosition = position.normalizedX;
    const mouseYPosition = position.normalizedY;
    const nearestControlPointIndex =
      transferFunction.findNearestControlPointIndex(mouseXPosition, window);
    if (nearestControlPointIndex === -1) {
      return -1;
    }
    const nearestControlPointPanelPosition =
      convertControlPointInputToPanelSpace(nearestControlPointIndex)!;
    if (
      Math.abs(mouseXPosition - nearestControlPointPanelPosition) >
      CONTROL_POINT_X_GRAB_DISTANCE
    ) {
      return -1;
    }
    // If points are nearby in X space, use Y space to break ties
    const possibleMatches: [number, number][] = [
      [
        nearestControlPointIndex,
        Math.abs(
          convertControlPointOpacityToPanelSpace(nearestControlPointIndex)! -
            mouseYPosition,
        ),
      ],
    ];
    const nextPosition = convertControlPointInputToPanelSpace(
      nearestControlPointIndex + 1,
    );
    const nextDistance =
      nextPosition !== null
        ? Math.abs(nextPosition - mouseXPosition)
        : Infinity;
    if (nextDistance <= CONTROL_POINT_X_GRAB_DISTANCE) {
      possibleMatches.push([
        nearestControlPointIndex + 1,
        Math.abs(
          convertControlPointOpacityToPanelSpace(
            nearestControlPointIndex + 1,
          )! - mouseYPosition,
        ),
      ]);
    }

    const previousPosition = convertControlPointInputToPanelSpace(
      nearestControlPointIndex - 1,
    );
    const previousDistance =
      previousPosition !== null
        ? Math.abs(previousPosition - mouseXPosition)
        : Infinity;
    if (previousDistance <= CONTROL_POINT_X_GRAB_DISTANCE) {
      possibleMatches.push([
        nearestControlPointIndex - 1,
        Math.abs(
          convertControlPointOpacityToPanelSpace(
            nearestControlPointIndex - 1,
          )! - mouseYPosition,
        ),
      ]);
    }
    const bestMatch = possibleMatches.sort((a, b) => a[1] - b[1])[0][0];
    return bestMatch;
  }
}

/**
 * Widget for the transfer function. Creates the UI elements required for the transfer function.
 */
class TransferFunctionWidget extends Tab {
  private transferFunctionPanel = this.registerDisposer(
    new TransferFunctionPanel(this),
  );

  window = createWindowBoundInputs(this.dataType, this.trackable);
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
    element.appendChild(this.window.container);
    this.window.container.dispatchEvent(new Event("change"));

    // Color picker element
    const colorPickerDiv = document.createElement("div");
    colorPickerDiv.classList.add("neuroglancer-transfer-function-color-picker");
    const colorPicker = this.registerDisposer(
      new ColorWidget(
        makeCachedDerivedWatchableValue(
          (x: TransferFunctionParameters) => x.defaultColor,
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
        defaultColor: colorPicker.model.value,
      };
    });
    colorPicker.element.addEventListener("input", () => {
      trackable.value = {
        ...this.trackable.value,
        defaultColor: colorPicker.model.value,
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
    updateInputBoundValue(
      this.window.inputs[0],
      this.trackable.value.window[0],
    );
    updateInputBoundValue(
      this.window.inputs[1],
      this.trackable.value.window[1],
    );
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
  return v < 0.0 ? vec4(0.0, 0.0, 0.0, 0.0) : ${name}_(clamp(v, 0.0, 1.0));
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
  sortedControlPoints: SortedControlPoints,
  lookupTableSize: number = defaultTransferFunctionSizes[dataType],
) {
  const { gl } = shader;
  const texture = shader.transferFunctionTextures.get(
    `TransferFunction.${name}`,
  );
  // Create a lookup table texture if it does not exist
  if (texture === undefined) {
    shader.transferFunctionTextures.set(
      `TransferFunction.${name}`,
      new ControlPointTexture(gl),
    );
  }
  const textureSize = shader.bindAndUpdateTransferFunctionTexture(
    `TransferFunction.${name}`,
    sortedControlPoints,
    dataType,
    lookupTableSize,
  );
  if (textureSize === undefined) {
    throw new Error("Failed to create transfer function texture");
  }

  // Bind the length of the lookup table to the shader as a uniform
  gl.uniform1f(shader.uniform(`uTransferFunctionEnd_${name}`), textureSize - 1);

  // Use the lerp shader function to grab an index into the lookup table
  const interval = sortedControlPoints.range;
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

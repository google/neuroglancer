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

import "#/widget/transfer_function.css";

import { CoordinateSpaceCombiner } from "#/coordinate_transform";
import { DisplayContext, IndirectRenderedPanel } from "#/display_context";
import { UserLayer } from "#/layer";
import { Position } from "#/navigation_state";
import {
  makeCachedDerivedWatchableValue,
  WatchableValueInterface,
} from "#/trackable_value";
import { ToolActivation } from "#/ui/tool";
import {
  arraysEqual,
  arraysEqualWithPredicate,
  findClosestMatchInSortedArray,
} from "#/util/array";
import { DATA_TYPE_SIGNED, DataType } from "#/util/data_type";
import { RefCounted } from "#/util/disposable";
import {
  EventActionMap,
  registerActionListener,
} from "#/util/event_action_map";
import { vec3, vec4 } from "#/util/geom";
import { computeLerp, DataTypeInterval, parseDataTypeValue } from "#/util/lerp";
import { MouseEventBinder } from "#/util/mouse_bindings";
import { startRelativeMouseDrag } from "#/util/mouse_drag";
import { WatchableVisibilityPriority } from "#/visibility_priority/frontend";
import { Buffer, getMemoizedBuffer } from "#/webgl/buffer";
import { GL } from "#/webgl/context";
import {
  defineInvlerpShaderFunction,
  enableLerpShaderFunction,
} from "#/webgl/lerp";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#/webgl/lines";
import { drawQuads } from "#/webgl/quad";
import { createGriddedRectangleArray } from "#/webgl/rectangle_grid_buffer";
import { ShaderBuilder, ShaderCodePart, ShaderProgram } from "#/webgl/shader";
import { getShaderType } from "#/webgl/shader_lib";
import { TransferFunctionParameters } from "#/webgl/shader_ui_controls";
import { setRawTextureParameters } from "#/webgl/texture";
import { ColorWidget } from "#/widget/color";
import {
  getUpdatedRangeAndWindowParameters,
  updateInputBoundValue,
  updateInputBoundWidth,
} from "#/widget/invlerp";
import { LayerControlFactory, LayerControlTool } from "#/widget/layer_control";
import { PositionWidget } from "#/widget/position_widget";
import { Tab } from "#/widget/tab_view";
import { Uint64 } from "#/util/uint64";

export const TRANSFER_FUNCTION_LENGTH = 1024;
export const NUM_COLOR_CHANNELS = 4;
const POSITION_VALUES_PER_LINE = 4; // x1, y1, x2, y2
const CONTROL_POINT_GRAB_DISTANCE = TRANSFER_FUNCTION_LENGTH / 40;
const TRANSFER_FUNCTION_BORDER_WIDTH = 255 / 10;

const transferFunctionSamplerTextureUnit = Symbol(
  "transferFunctionSamplerTexture",
);

/**
 * The position of a control point on the canvas is represented as an integer value between 0 and TRANSFER_FUNCTION_LENGTH - 1.
 * The color of a control point is represented as four component vector of uint8 values between 0 and 255
 */
export interface ControlPoint {
  position: number;
  color: vec4;
}

/**
 * A parsed control point could have a position represented as a Uint64
 * This will later be converted to a number between 0 and TRANSFER_FUNCTION_LENGTH - 1
 * And then stored as a control point
 */
export interface ParsedControlPoint {
  position: number | Uint64;
  color: vec4;
}

/**
 * Used to update the transfer function texture
 * If lookupTable is defined, it will be used to update the texture directly
 * Otherwise, controlPoints will be used to generate a lookup table as a first step
 * textureUnit is the texture unit to use for the transfer function texture
 * A lookup table is a series of color values (0 - 255) between control points
 */
export interface TransferFunctionTextureOptions {
  lookupTable?: Uint8Array;
  controlPoints?: ControlPoint[];
  textureUnit: number | undefined;
}

interface CanvasPosition {
  normalizedX: number;
  normalizedY: number;
}

/**
 * Fill a lookup table with color values between control points via linear interpolation. Everything
 * before the first point is transparent, everything after the last point has the color of the last
 * point.
 * @param out The lookup table to fill
 * @param controlPoints The control points to interpolate between
 */
export function lerpBetweenControlPoints(
  out: Uint8Array,
  controlPoints: ControlPoint[],
) {
  function addLookupValue(index: number, color: vec4) {
    out[index] = color[0];
    out[index + 1] = color[1];
    out[index + 2] = color[2];
    out[index + 3] = color[3];
  }

  // Edge case: no control points - all transparent
  if (controlPoints.length === 0) {
    out.fill(0);
    return;
  }
  const firstPoint = controlPoints[0];

  // Edge case: first control point is not at 0 - fill in transparent values
  if (firstPoint.position > 0) {
    const transparent = vec4.fromValues(0, 0, 0, 0);
    for (let i = 0; i < firstPoint.position; ++i) {
      const index = i * NUM_COLOR_CHANNELS;
      addLookupValue(index, transparent);
    }
  }

  // Interpolate between control points and fill to end with last color
  let controlPointIndex = 0;
  for (let i = firstPoint.position; i < TRANSFER_FUNCTION_LENGTH; ++i) {
    const currentPoint = controlPoints[controlPointIndex];
    const nextPoint =
      controlPoints[Math.min(controlPointIndex + 1, controlPoints.length - 1)];
    const lookupIndex = i * NUM_COLOR_CHANNELS;
    if (currentPoint === nextPoint) {
      addLookupValue(lookupIndex, currentPoint.color);
    } else {
      const t =
        (i - currentPoint.position) /
        (nextPoint.position - currentPoint.position);
      const lerpedColor = lerpUint8Color(
        currentPoint.color,
        nextPoint.color,
        t,
      );
      addLookupValue(lookupIndex, lerpedColor);
      if (i === nextPoint.position) {
        controlPointIndex++;
      }
    }
  }
}

/**
 * Convert a [0, 1] float to a uint8 value between 0 and 255
 */
export function floatToUint8(float: number) {
  return Math.min(255, Math.max(Math.round(float * 255), 0));
}

/**
 * Linearly interpolate between each component of two vec4s (color values)
 */
function lerpUint8Color(startColor: vec4, endColor: vec4, t: number) {
  const color = vec4.create();
  for (let i = 0; i < 4; ++i) {
    color[i] = computeLerp(
      [startColor[i], endColor[i]],
      DataType.UINT8,
      t,
    ) as number;
  }
  return color;
}

/**
 * Represent the underlying transfer function lookup table as a texture
 */
export class TransferFunctionTexture extends RefCounted {
  texture: WebGLTexture | null = null;
  width: number = TRANSFER_FUNCTION_LENGTH;
  height = 1;
  private priorOptions: TransferFunctionTextureOptions | undefined = undefined;

  constructor(public gl: GL | null) {
    super();
  }

  optionsEqual(
    existingOptions: TransferFunctionTextureOptions | undefined,
    newOptions: TransferFunctionTextureOptions,
  ) {
    if (existingOptions === undefined) return false;
    let lookupTableEqual = true;
    if (
      existingOptions.lookupTable !== undefined &&
      newOptions.lookupTable !== undefined
    ) {
      lookupTableEqual = arraysEqual(
        existingOptions.lookupTable,
        newOptions.lookupTable,
      );
    }
    let controlPointsEqual = true;
    if (
      existingOptions.controlPoints !== undefined &&
      newOptions.controlPoints !== undefined
    ) {
      controlPointsEqual = arraysEqualWithPredicate(
        existingOptions.controlPoints,
        newOptions.controlPoints,
        (a, b) => a.position === b.position && arraysEqual(a.color, b.color),
      );
    }
    const textureUnitEqual =
      existingOptions.textureUnit === newOptions.textureUnit;

    return lookupTableEqual && controlPointsEqual && textureUnitEqual;
  }

  updateAndActivate(options: TransferFunctionTextureOptions) {
    const { gl } = this;
    if (gl === null) return;
    if (
      options.lookupTable === undefined &&
      options.controlPoints === undefined
    ) {
      throw new Error(
        "Either lookupTable or controlPoints must be defined for transfer function texture",
      );
    }
    let { texture } = this;

    function bindAndActivateTexture(gl: GL) {
      if (options.textureUnit === undefined) {
        throw new Error(
          "Texture unit must be defined for transfer function texture",
        );
      }
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + options.textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    }

    // If the texture is already up to date, just bind and activate it
    if (texture !== null && this.optionsEqual(this.priorOptions, options)) {
      bindAndActivateTexture(gl);
      return;
    }
    // If the texture has not been created yet, create it
    if (texture === null) {
      texture = this.texture = gl.createTexture();
    }
    // Update the texture
    bindAndActivateTexture(gl);
    setRawTextureParameters(gl);
    let lookupTable = options.lookupTable;
    if (lookupTable === undefined) {
      lookupTable = new Uint8Array(
        TRANSFER_FUNCTION_LENGTH * NUM_COLOR_CHANNELS,
      );
      lerpBetweenControlPoints(lookupTable, options.controlPoints!);
    }
    gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      0,
      WebGL2RenderingContext.RGBA,
      this.width,
      1,
      0,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      lookupTable,
    );

    // Update the prior options to the current options for future comparisons
    // Make a copy of the options for the purpose of comparison
    this.priorOptions = {
      textureUnit: options.textureUnit,
      lookupTable: options.lookupTable?.slice(),
      controlPoints: options.controlPoints?.map((point) => ({
        position: point.position,
        color: vec4.clone(point.color),
      })),
    };
  }

  disposed() {
    this.gl?.deleteTexture(this.texture);
    this.texture = null;
    super.disposed();
  }
}

/**
 * Display the UI canvas for the transfer function widget and handle shader updates for elements of
 * the canvas
 */
class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: TransferFunctionTexture;
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
  controlPointsLookupTable = this.registerDisposer(
    new ControlPointsLookupTable(this.parent.dataType, this.parent.trackable),
  );
  controller = this.registerDisposer(
    new TransferFunctionController(
      this.element,
      this.parent.dataType,
      this.controlPointsLookupTable,
      () => this.parent.trackable.value,
      (value: TransferFunctionParameters) => {
        this.parent.trackable.value = value;
      },
    ),
  );
  constructor(public parent: TransferFunctionWidget) {
    super(parent.display, document.createElement("div"), parent.visibility);
    const { element } = this;
    element.classList.add("neuroglancer-transfer-function-panel");
    this.textureVertexBufferArray = createGriddedRectangleArray(
      TRANSFER_FUNCTION_LENGTH,
    );
    this.texture = this.registerDisposer(new TransferFunctionTexture(this.gl));
    this.textureVertexBuffer = this.registerDisposer(
      getMemoizedBuffer(
        this.gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => this.textureVertexBufferArray,
      ),
    ).value;
    this.controlPointsVertexBuffer = this.registerDisposer(
      getMemoizedBuffer(
        this.gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => this.controlPointsPositionArray,
      ),
    ).value;
    this.controlPointsColorBuffer = this.registerDisposer(
      getMemoizedBuffer(
        this.gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => this.controlPointsColorArray,
      ),
    ).value;
    this.linePositionBuffer = this.registerDisposer(
      getMemoizedBuffer(
        this.gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        () => this.linePositionArray,
      ),
    ).value;
  }

  updateTransferFunctionPanelLines() {
    // Normalize position to [-1, 1] for shader (x axis)
    function normalizePosition(position: number) {
      return (position / (TRANSFER_FUNCTION_LENGTH - 1)) * 2 - 1;
    }
    // Normalize opacity to [-1, 1] for shader (y axis)
    function normalizeOpacity(opacity: number) {
      return (opacity / 255) * 2 - 1;
    }
    // Normalize color to [0, 1] for shader (color channels)
    function normalizeColor(colorComponent: number) {
      return colorComponent / 255;
    }

    function createLinePoints(
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

    const colorChannels = NUM_COLOR_CHANNELS - 1; // ignore alpha
    const controlPoints =
      this.controlPointsLookupTable.trackable.value.controlPoints;
    const colorArray = new Float32Array(controlPoints.length * colorChannels);
    const positionArray = new Float32Array(controlPoints.length * 2);
    let numLines = controlPoints.length - 1;
    let startAdd = null;
    let endAdd = null;
    let lineIndex = 0;

    // Add lines to the beginning and end if necessary
    if (controlPoints.length > 0) {
      if (controlPoints[0].position > 0) {
        numLines += 1;
        startAdd = {
          position: controlPoints[0].position,
          color: vec4.fromValues(0, 0, 0, 0),
        };
      }
      if (
        controlPoints[controlPoints.length - 1].position <
        TRANSFER_FUNCTION_LENGTH - 1
      ) {
        numLines += 1;
        endAdd = {
          position: TRANSFER_FUNCTION_LENGTH - 1,
          color: controlPoints[controlPoints.length - 1].color,
        };
      }
    } else {
      numLines = 0;
    }

    // Create line positions
    const linePositionArray = new Float32Array(
      numLines * VERTICES_PER_LINE * POSITION_VALUES_PER_LINE,
    );
    if (startAdd !== null) {
      const linePosition = vec4.fromValues(
        startAdd.position,
        startAdd.color[3],
        controlPoints[0].position,
        controlPoints[0].color[3],
      );
      lineIndex = createLinePoints(linePositionArray, lineIndex, linePosition);
    }
    for (let i = 0; i < controlPoints.length; ++i) {
      const colorIndex = i * colorChannels;
      const positionIndex = i * 2;
      const { color, position } = controlPoints[i];
      colorArray[colorIndex] = normalizeColor(color[0]);
      colorArray[colorIndex + 1] = normalizeColor(color[1]);
      colorArray[colorIndex + 2] = normalizeColor(color[2]);
      positionArray[positionIndex] = normalizePosition(position);
      positionArray[positionIndex + 1] = normalizeOpacity(color[3]);
      if (i < controlPoints.length - 1) {
        const linePosition = vec4.fromValues(
          position,
          color[3],
          controlPoints[i + 1].position,
          controlPoints[i + 1].color[3],
        );
        lineIndex = createLinePoints(
          linePositionArray,
          lineIndex,
          linePosition,
        );
      }
    }
    if (endAdd !== null) {
      const linePosition = vec4.fromValues(
        controlPoints[controlPoints.length - 1].position,
        controlPoints[controlPoints.length - 1].color[3],
        endAdd.position,
        endAdd.color[3],
      );
      lineIndex = createLinePoints(linePositionArray, lineIndex, linePosition);
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
        TRANSFER_FUNCTION_LENGTH - 1,
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
        lookupTable: this.controlPointsLookupTable.lookupTable,
        textureUnit,
      });
      drawQuads(this.gl, TRANSFER_FUNCTION_LENGTH, 1);
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
    this.controlPointsLookupTable.lookupTableFromControlPoints();
    this.updateTransferFunctionPanelLines();
  }
  isReady() {
    return true;
  }
}

/**
 * Lookup table for control points. Handles adding, removing, and updating control points as well as
 * consequent updates to the underlying lookup table formed from the control points.
 */
class ControlPointsLookupTable extends RefCounted {
  lookupTable: Uint8Array;
  constructor(
    public dataType: DataType,
    public trackable: WatchableValueInterface<TransferFunctionParameters>,
  ) {
    super();
    this.lookupTable = new Uint8Array(
      TRANSFER_FUNCTION_LENGTH * NUM_COLOR_CHANNELS,
    ).fill(0);
  }
  positionToIndex(position: number) {
    return Math.floor(position * (TRANSFER_FUNCTION_LENGTH - 1));
  }
  opacityToIndex(opacity: number) {
    let opacityAsUint8 = floatToUint8(opacity);
    if (opacityAsUint8 <= TRANSFER_FUNCTION_BORDER_WIDTH) {
      opacityAsUint8 = 0;
    } else if (opacityAsUint8 >= 255 - TRANSFER_FUNCTION_BORDER_WIDTH) {
      opacityAsUint8 = 255;
    }
    return opacityAsUint8;
  }
  findNearestControlPointIndex(position: number) {
    return findClosestMatchInSortedArray(
      this.trackable.value.controlPoints.map((point) => point.position),
      this.positionToIndex(position),
      (a, b) => a - b,
    );
  }
  grabControlPoint(position: number) {
    const nearestIndex = this.findNearestControlPointIndex(position);
    if (nearestIndex === -1) {
      return -1;
    }
    const nearestPosition =
      this.trackable.value.controlPoints[nearestIndex].position;
    const desiredPosition = this.positionToIndex(position);
    if (
      Math.abs(nearestPosition - desiredPosition) < CONTROL_POINT_GRAB_DISTANCE
    ) {
      return nearestIndex;
    }
    return -1;
  }
  addPoint(position: number, opacity: number, color: vec3) {
    const colorAsUint8 = vec3.fromValues(
      floatToUint8(color[0]),
      floatToUint8(color[1]),
      floatToUint8(color[2]),
    );
    const opacityAsUint8 = this.opacityToIndex(opacity);
    const controlPoints = this.trackable.value.controlPoints;
    const positionAsIndex = this.positionToIndex(position);
    const existingIndex = controlPoints.findIndex(
      (point) => point.position === positionAsIndex,
    );
    if (existingIndex !== -1) {
      controlPoints.splice(existingIndex, 1);
    }
    controlPoints.push({
      position: positionAsIndex,
      color: vec4.fromValues(
        colorAsUint8[0],
        colorAsUint8[1],
        colorAsUint8[2],
        opacityAsUint8,
      ),
    });
    controlPoints.sort((a, b) => a.position - b.position);
  }
  lookupTableFromControlPoints() {
    const { lookupTable } = this;
    const { controlPoints } = this.trackable.value;
    lerpBetweenControlPoints(lookupTable, controlPoints);
  }
  updatePoint(index: number, position: number, opacity: number) {
    const { controlPoints } = this.trackable.value;
    const positionAsIndex = this.positionToIndex(position);
    const opacityAsUint8 = this.opacityToIndex(opacity);
    const color = controlPoints[index].color;
    controlPoints[index] = {
      position: positionAsIndex,
      color: vec4.fromValues(color[0], color[1], color[2], opacityAsUint8),
    };
    controlPoints.sort((a, b) => a.position - b.position);
    const exsitingPositions = new Set<number>();
    for (const point of controlPoints) {
      if (exsitingPositions.has(point.position)) {
        return index;
      }
      exsitingPositions.add(point.position);
    }
    const newControlPointIndex = controlPoints.findIndex(
      (point) => point.position === positionAsIndex,
    );
    return newControlPointIndex;
  }
  setPointColor(index: number, color: vec3) {
    const { controlPoints } = this.trackable.value;
    const colorAsUint8 = vec3.fromValues(
      floatToUint8(color[0]),
      floatToUint8(color[1]),
      floatToUint8(color[2]),
    );
    controlPoints[index].color = vec4.fromValues(
      colorAsUint8[0],
      colorAsUint8[1],
      colorAsUint8[2],
      controlPoints[index].color[3],
    );
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
  "shift?+dblclick0": { action: "remove-point" },
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
    private controlPointsLookupTable: ControlPointsLookupTable,
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
          this.controlPointsLookupTable.trackable.value.controlPoints.splice(
            nearestIndex,
            1,
          );
          this.updateValue({
            ...this.getModel(),
            controlPoints:
              this.controlPointsLookupTable.trackable.value.controlPoints,
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
          const color = this.controlPointsLookupTable.trackable.value.color;
          this.controlPointsLookupTable.setPointColor(nearestIndex, color);
          this.updateValue({
            ...this.getModel(),
            controlPoints:
              this.controlPointsLookupTable.trackable.value.controlPoints,
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
    const { normalizedX } = this.getControlPointPosition(
      event,
    ) as CanvasPosition;
    return this.controlPointsLookupTable.grabControlPoint(normalizedX);
  }
  addControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    const color = this.controlPointsLookupTable.trackable.value.color;
    const nearestIndex = this.findNearestControlPointIndex(event);
    if (nearestIndex !== -1) {
      this.currentGrabbedControlPointIndex = nearestIndex;
      return undefined;
    }
    const { normalizedX, normalizedY } = this.getControlPointPosition(
      event,
    ) as CanvasPosition;
    this.controlPointsLookupTable.addPoint(normalizedX, normalizedY, color);
    this.currentGrabbedControlPointIndex =
      this.findNearestControlPointIndex(event);
    return {
      ...this.getModel(),
      controlPoints:
        this.controlPointsLookupTable.trackable.value.controlPoints,
    };
  }
  moveControlPoint(event: MouseEvent): TransferFunctionParameters | undefined {
    if (this.currentGrabbedControlPointIndex !== -1) {
      const position = this.getControlPointPosition(event);
      if (position === undefined) return undefined;
      const { normalizedX, normalizedY } = position;
      this.currentGrabbedControlPointIndex =
        this.controlPointsLookupTable.updatePoint(
          this.currentGrabbedControlPointIndex,
          normalizedX,
          normalizedY,
        );
      return {
        ...this.getModel(),
        controlPoints:
          this.controlPointsLookupTable.trackable.value.controlPoints,
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

      // We setup the ability to change the channel through the UI here
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

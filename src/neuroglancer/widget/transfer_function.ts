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

import './transfer_function.css';

import {DisplayContext, IndirectRenderedPanel} from 'neuroglancer/display_context';
import {UserLayer} from 'neuroglancer/layer';
import {makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ToolActivation} from 'neuroglancer/ui/tool';
import {DataType} from 'neuroglancer/util/data_type';
import {RefCounted} from 'neuroglancer/util/disposable';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3, vec4} from 'neuroglancer/util/geom';
import {computeLerp, DataTypeInterval, parseDataTypeValue} from 'neuroglancer/util/lerp';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {defineInvlerpShaderFunction} from 'neuroglancer/webgl/lerp';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {VERTICES_PER_QUAD} from 'neuroglancer/webgl/quad';
import {ShaderBuilder, ShaderCodePart, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {TransferFunctionParameters} from 'neuroglancer/webgl/shader_ui_controls';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';
import {ColorWidget} from 'neuroglancer/widget/color';
import {getUpdatedRangeAndWindowParameters, updateInputBoundValue, updateInputBoundWidth} from 'neuroglancer/widget/invlerp';
import {LayerControlFactory, LayerControlTool} from 'neuroglancer/widget/layer_control';
import {Tab} from 'neuroglancer/widget/tab_view';
import {startRelativeMouseDrag} from 'src/neuroglancer/util/mouse_drag';

const NUM_COLOR_CHANNELS = 4;
const POSITION_VALUES_PER_LINE = 4;  // x1, y1, x2, y2
export const TRANSFER_FUNCTION_LENGTH = 512;
const CONTROL_POINT_GRAB_DISTANCE = TRANSFER_FUNCTION_LENGTH / 40;
const TRANSFER_FUNCTION_BORDER_WIDTH = 23;

const transferFunctionSamplerTextureUnit = Symbol('transferFunctionSamplerTexture');

export interface ControlPoint {
  position: number;
  color: vec4;
}

export interface TransferFunctionTextureOptions {
  controlPoints: ControlPointsLookupTable;
  textureUnit: number;
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
function lerpBetweenControlPoints(out: Int32Array|Uint8Array, controlPoints: Array<ControlPoint>) {
  function addLookupValue(index: number, color: vec4) {
    out[index] = color[0];
    out[index + 1] = color[1];
    out[index + 2] = color[2];
    out[index + 3] = color[3];
  }

  if (controlPoints.length === 0) {
    out.fill(0);
    return;
  }
  const firstPoint = controlPoints[0];

  if (firstPoint.position > 0) {
    const transparent = vec4.fromValues(0, 0, 0, 0);
    for (let i = 0; i < firstPoint.position; ++i) {
      const index = i * NUM_COLOR_CHANNELS;
      addLookupValue(index, transparent);
    }
  }

  let controlPointIndex = 0;
  for (let i = firstPoint.position; i < TRANSFER_FUNCTION_LENGTH; ++i) {
    const currentPoint = controlPoints[controlPointIndex];
    const nextPoint = controlPoints[Math.min(controlPointIndex + 1, controlPoints.length - 1)];
    const lookupIndex = i * NUM_COLOR_CHANNELS;
    if (currentPoint === nextPoint) {
      addLookupValue(lookupIndex, currentPoint.color);
    } else if (i < nextPoint.position) {
      const t = (i - currentPoint.position) / (nextPoint.position - currentPoint.position);
      const lerpedColor = lerpUint8Color(currentPoint.color, nextPoint.color, t);
      addLookupValue(lookupIndex, lerpedColor);
    } else {
      addLookupValue(lookupIndex, nextPoint.color);
      controlPointIndex++;
    }
  }
}

// TODO (skm) move this to a more general location
function findClosestValueIndexInSortedArray(array: Array<number>, value: number) {
  if (array.length === 0) {
    return -1;
  }

  let start = 0;
  let end = array.length - 1;

  while (start <= end) {
    const mid = Math.floor((start + end) / 2);
    if (array[mid] === value) {
      return mid;
    } else if (array[mid] < value) {
      start = mid + 1;
    } else {
      end = mid - 1;
    }
  }

  start = Math.min(start, array.length - 1);
  end = Math.max(end, 0);
  const startDiff = Math.abs(array[start] - value);
  const endDiff = Math.abs(array[end] - value);
  return startDiff < endDiff ? start : end;
}

/**
 * Convert a [0, 1] float to a uint8 value between 0 and 255
 */
function floatToUint8(float: number) {
  return Math.min(255, Math.max(Math.round(float * 255), 0));
}

/**
 * Linearly interpolate between each component of two vec4s (color values)
 */
function lerpUint8Color(startColor: vec4, endColor: vec4, t: number) {
  const color = vec4.create();
  for (let i = 0; i < 4; ++i) {
    color[i] = computeLerp([startColor[i], endColor[i]], DataType.UINT8, t) as number;
  }
  return color;
}

/**
 * Create a Float32Array of vertices for a canvas filling rectangle with the given number of grids
 * in the x direction
 */
function griddedRectangleArray(numGrids: number): Float32Array {
  const result = new Float32Array(numGrids * VERTICES_PER_QUAD * 2);
  const width = 2;
  const height = 1;
  let start = -width / 2;
  const step = width / numGrids;
  for (let i = 0; i < numGrids; ++i) {
    const end = start + step;
    const index = i * VERTICES_PER_QUAD * 2;

    // Triangle 1 - top-left, top-right, bottom-right
    result[index] = start;        // top-left x
    result[index + 1] = height;   // top-left y
    result[index + 2] = end       // top-right x
    result[index + 3] = height;   // top-right y
    result[index + 4] = end;      // bottom-right x
    result[index + 5] = -height;  // bottom-right y

    // Triangle 2 - top-left, bottom-right, bottom-left
    result[index + 6] = start;     // top-left x
    result[index + 7] = height;    // top-left y
    result[index + 8] = end;       // bottom-right x
    result[index + 9] = -height;   // bottom-right y
    result[index + 10] = start;    // bottom-left x
    result[index + 11] = -height;  // bottom-left y
    start += step;
  }
  return result;
}

/**
 * Represent the underlying transfer function as a texture
 */
class TransferFunctionTexture extends RefCounted {
  texture: WebGLTexture|null = null;
  width: number = TRANSFER_FUNCTION_LENGTH;
  height: number = 1;
  private priorOptions: TransferFunctionTextureOptions|undefined = undefined;

  constructor(public gl: GL) {
    super();
  }

  updateAndActivate(options: TransferFunctionTextureOptions) {
    const {gl} = this;
    let {texture} = this;
    // TODO (skm) might be able to do more efficient updates
    if (texture !== null && options === this.priorOptions) {
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + options.textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      return;
    }
    if (texture === null) {
      texture = this.texture = gl.createTexture();
    }
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + options.textureUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    setRawTextureParameters(gl);
    gl.texImage2D(
        WebGL2RenderingContext.TEXTURE_2D, 0, WebGL2RenderingContext.RGBA, this.width, 1, 0,
        WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE,
        options.controlPoints.lookupTable);
    this.priorOptions = options;
  }

  disposed() {
    this.gl.deleteTexture(this.texture);
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
  private vertexBuffer: Buffer;
  private controlPointsVertexBuffer: Buffer;
  private controlPointsColorBuffer: Buffer;
  private controlPointsPositionArray = new Float32Array();
  private controlPointsColorArray = new Float32Array();
  private linePositionBuffer: Buffer;
  private linePositionArray = new Float32Array();
  get drawOrder() {
    return 1;
  }
  controlPointsLookupTable = this.registerDisposer(
      new ControlPointsLookupTable(this.parent.dataType, this.parent.trackable));
  controller = this.registerDisposer(new TransferFunctionController(
      this.element, this.parent.dataType, this.controlPointsLookupTable,
      () => this.parent.trackable.value, (value: TransferFunctionParameters) => {
        this.parent.trackable.value = value;
      }));
  constructor(public parent: TransferFunctionWidget) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-transfer-function-panel');
    this.texture = this.registerDisposer(new TransferFunctionTexture(this.gl));
    this.vertexBuffer = this.registerDisposer(getMemoizedBuffer(
                                                  this.gl, WebGL2RenderingContext.ARRAY_BUFFER,
                                                  griddedRectangleArray, TRANSFER_FUNCTION_LENGTH))
                            .value;
    this.controlPointsVertexBuffer =
        this.registerDisposer(getMemoizedBuffer(
                                  this.gl, WebGL2RenderingContext.ARRAY_BUFFER,
                                  () => this.controlPointsPositionArray))
            .value;
    this.controlPointsColorBuffer =
        this
            .registerDisposer(getMemoizedBuffer(
                this.gl, WebGL2RenderingContext.ARRAY_BUFFER, () => this.controlPointsColorArray))
            .value;
    this.linePositionBuffer =
        this
            .registerDisposer(getMemoizedBuffer(
                this.gl, WebGL2RenderingContext.ARRAY_BUFFER, () => this.linePositionArray))
            .value;
  }

  updateTransferFunctionPanelLines() {
    function normalizePosition(position: number) {
      return (position / (TRANSFER_FUNCTION_LENGTH - 1)) * 2 - 1;
    }
    function normalizeOpacity(opacity: number) {
      return (opacity / 255) * 2 - 1;
    }
    function normalizeColor(colorComponent: number) {
      return (colorComponent / 255);
    }

    function createLinePoints(array: Float32Array, index: number, positions: vec4): number {
      for (let i = 0; i < VERTICES_PER_LINE; ++i) {
        array[index++] = normalizePosition(positions[0]);
        array[index++] = normalizeOpacity(positions[1]);
        array[index++] = normalizePosition(positions[2]);
        array[index++] = normalizeOpacity(positions[3]);
      }
      return index
    }

    const colorChannels = NUM_COLOR_CHANNELS - 1;  // ignore alpha
    const controlPoints = this.controlPointsLookupTable.trackable.value.controlPoints;
    const colorArray = new Float32Array(controlPoints.length * colorChannels);
    const positionArray = new Float32Array(controlPoints.length * 2);
    let numLines = controlPoints.length - 1;
    let startAdd = null;
    let endAdd = null;
    let lineIndex = 0;
    if (controlPoints.length > 0) {
      if (controlPoints[0].position > 0) {
        numLines += 1;
        startAdd = {position: controlPoints[0].position, color: vec4.fromValues(0, 0, 0, 0)};
      }
      if (controlPoints[controlPoints.length - 1].position < TRANSFER_FUNCTION_LENGTH - 1) {
        numLines += 1;
        endAdd = {
          position: TRANSFER_FUNCTION_LENGTH - 1,
          color: controlPoints[controlPoints.length - 1].color
        };
      }
    } else {
      numLines = 0;
    }

    const linePositionArray =
        new Float32Array(numLines * VERTICES_PER_LINE * POSITION_VALUES_PER_LINE);
    if (startAdd !== null) {
      const linePosition = vec4.fromValues(
          startAdd.position, startAdd.color[3], controlPoints[0].position,
          controlPoints[0].color[3]);
      lineIndex = createLinePoints(linePositionArray, lineIndex, linePosition);
    }

    for (let i = 0; i < controlPoints.length; ++i) {
      const colorIndex = i * colorChannels;
      const positionIndex = i * 2;
      const {color, position} = controlPoints[i];
      colorArray[colorIndex] = normalizeColor(color[0]);
      colorArray[colorIndex + 1] = normalizeColor(color[1]);
      colorArray[colorIndex + 2] = normalizeColor(color[2]);
      positionArray[positionIndex] = normalizePosition(position);
      positionArray[positionIndex + 1] = normalizeOpacity(color[3]);
      if (i < controlPoints.length - 1) {
        const linePosition = vec4.fromValues(
            position, color[3], controlPoints[i + 1].position, controlPoints[i + 1].color[3]);
        lineIndex = createLinePoints(linePositionArray, lineIndex, linePosition);
      }
    }

    if (endAdd !== null) {
      const linePosition = vec4.fromValues(
          controlPoints[controlPoints.length - 1].position,
          controlPoints[controlPoints.length - 1].color[3], endAdd.position, endAdd.color[3]);
      lineIndex = createLinePoints(linePositionArray, lineIndex, linePosition);
    }

    this.controlPointsColorArray = colorArray;
    this.controlPointsPositionArray = positionArray;
    this.linePositionArray = linePositionArray;
    this.controlPointsVertexBuffer.setData(this.controlPointsPositionArray);
    this.controlPointsColorBuffer.setData(this.controlPointsColorArray);
    this.linePositionBuffer.setData(this.linePositionArray);
  }

  private transferFunctionLineShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    defineLineShader(builder);
    builder.addAttribute('vec4', 'aLineStartEnd');
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.addVarying('float', 'vColor');
    builder.setVertexMain(`
vec4 start = vec4(aLineStartEnd[0], aLineStartEnd[1], 0.0, 1.0);
vec4 end = vec4(aLineStartEnd[2], aLineStartEnd[3], 0.0, 1.0);
emitLine(start, end, 1.0);
`);
    builder.setFragmentMain(`
out_color = vec4(0.0, 1.0, 1.0, getLineAlpha());
`);
    return builder.build();
  })());

  private transferFunctionShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    builder.addAttribute('vec2', 'aVertexPosition');
    builder.addVarying('vec2', 'vTexCoord');
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.addTextureSampler('sampler2D', 'uSampler', transferFunctionSamplerTextureUnit);
    builder.addUniform('float', 'uTransferFunctionEnd');
    builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
vTexCoord = (aVertexPosition + 1.0) / 2.0;
`);
    builder.setFragmentMain(`
ivec2 texel = ivec2(floor(vTexCoord.x * uTransferFunctionEnd), 0);
out_color = texelFetch(uSampler, texel, 0);
`);
    return builder.build();
  })());

  private controlPointsShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    builder.addAttribute('vec2', 'aVertexPosition');
    builder.addAttribute('vec3', 'aVertexColor');
    builder.addVarying('vec3', 'vColor');
    builder.addOutputBuffer('vec4', 'out_color', 0);
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
  })());

  drawIndirect() {
    const {transferFunctionLineShader, gl, transferFunctionShader, controlPointsShader} = this;
    this.setGLLogicalViewport();
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.disable(WebGL2RenderingContext.STENCIL_TEST);
    {
      transferFunctionShader.bind();
      const aVertexPosition = transferFunctionShader.attribute('aVertexPosition');
      gl.uniform1f(
          transferFunctionShader.uniform('uTransferFunctionEnd'), TRANSFER_FUNCTION_LENGTH - 1);
      this.vertexBuffer.bindToVertexAttrib(
          aVertexPosition, /*components=*/ 2, /*attributeType=*/ WebGL2RenderingContext.FLOAT);
      const textureUnit = transferFunctionShader.textureUnit(transferFunctionSamplerTextureUnit);
      this.texture.updateAndActivate({controlPoints: this.controlPointsLookupTable, textureUnit});
      gl.drawArrays(gl.TRIANGLES, 0, TRANSFER_FUNCTION_LENGTH * VERTICES_PER_QUAD);
      gl.disableVertexAttribArray(aVertexPosition);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    }
    if (this.controlPointsPositionArray.length > 0) {
      const {renderViewport} = this;
      transferFunctionLineShader.bind();
      const aLineStartEnd = transferFunctionLineShader.attribute('aLineStartEnd');
      this.linePositionBuffer.bindToVertexAttrib(
          aLineStartEnd, /*components=*/ 4, /*attributeType=*/ WebGL2RenderingContext.FLOAT);
      initializeLineShader(
          transferFunctionLineShader,
          {width: renderViewport.logicalWidth, height: renderViewport.logicalHeight},
          /*featherWidthInPixels=*/ 1);
      drawLines(
          gl, this.linePositionArray.length / (VERTICES_PER_LINE * POSITION_VALUES_PER_LINE), 1);
      gl.disableVertexAttribArray(aLineStartEnd);

      controlPointsShader.bind();
      const aVertexPosition = controlPointsShader.attribute('aVertexPosition');
      this.controlPointsVertexBuffer.bindToVertexAttrib(
          aVertexPosition, /*components=*/ 2, /*attributeType=*/ WebGL2RenderingContext.FLOAT);
      const aVertexColor = controlPointsShader.attribute('aVertexColor');
      this.controlPointsColorBuffer.bindToVertexAttrib(
          aVertexColor, /*components=*/ 3, /*attributeType=*/ WebGL2RenderingContext.FLOAT);
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

// TODO (skm) control points might need two positions, one for the actual position and one for the
// display position
// TODO (skm) however, this might make it a bit awkward for texturing
// TODO (skm) does this need data type?
/**
 * Lookup table for control points. Handles adding, removing, and updating control points as well as
 * consequent updates to the underlying lookup table formed from the control points.
 */
class ControlPointsLookupTable extends RefCounted {
  lookupTable: Uint8Array;
  constructor(
      public dataType: DataType,
      public trackable: WatchableValueInterface<TransferFunctionParameters>) {
    super();
    this.lookupTable = new Uint8Array(TRANSFER_FUNCTION_LENGTH * NUM_COLOR_CHANNELS).fill(0);
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
    return findClosestValueIndexInSortedArray(
        this.trackable.value.controlPoints.map((point) => point.position),
        this.positionToIndex(position));
  }
  grabControlPoint(position: number) {
    const nearestIndex = this.findNearestControlPointIndex(position);
    if (nearestIndex === -1) {
      return -1;
    }
    const nearestPosition = this.trackable.value.controlPoints[nearestIndex].position;
    const desiredPosition = this.positionToIndex(position);
    if (Math.abs(nearestPosition - desiredPosition) < CONTROL_POINT_GRAB_DISTANCE) {
      return nearestIndex;
    } else {
      return -1;
    }
  }
  addPoint(position: number, opacity: number, color: vec3) {
    const colorAsUint8 =
        vec3.fromValues(floatToUint8(color[0]), floatToUint8(color[1]), floatToUint8(color[2]));
    let opacityAsUint8 = this.opacityToIndex(opacity);
    const controlPoints = this.trackable.value.controlPoints;
    const positionAsIndex = this.positionToIndex(position);
    const existingIndex = controlPoints.findIndex((point) => point.position === positionAsIndex);
    if (existingIndex !== -1) {
      controlPoints.splice(existingIndex, 1);
    }
    controlPoints.push({
      position: positionAsIndex,
      color: vec4.fromValues(colorAsUint8[0], colorAsUint8[1], colorAsUint8[2], opacityAsUint8)
    });
    controlPoints.sort((a, b) => a.position - b.position);
  }
  lookupTableFromControlPoints() {
    const {lookupTable} = this;
    const {controlPoints} = this.trackable.value;
    lerpBetweenControlPoints(lookupTable, controlPoints);
  }
  updatePoint(index: number, position: number, opacity: number) {
    const {controlPoints} = this.trackable.value;
    const positionAsIndex = this.positionToIndex(position);
    let opacityAsUint8 = floatToUint8(opacity);
    const color = controlPoints[index].color;
    controlPoints[index] = {
      position: positionAsIndex,
      color: vec4.fromValues(color[0], color[1], color[2], opacityAsUint8)
    };
    controlPoints.sort((a, b) => a.position - b.position);
    const newControlPointIndex =
        controlPoints.findIndex((point) => point.position === positionAsIndex);
    return newControlPointIndex;
  }
  setPointColor(index: number, color: vec3) {
    const {controlPoints} = this.trackable.value;
    const colorAsUint8 =
        vec3.fromValues(floatToUint8(color[0]), floatToUint8(color[1]), floatToUint8(color[2]));
    controlPoints[index].color = vec4.fromValues(
        colorAsUint8[0], colorAsUint8[1], colorAsUint8[2], controlPoints[index].color[3]);
  }
}


/**
 * Create the bounds on the UI range inputs for the transfer function widget
 */
function createRangeBoundInputs(
    dataType: DataType, model: WatchableValueInterface<TransferFunctionParameters>) {
  function createRangeBoundInput(endpoint: number): HTMLInputElement {
    const e = document.createElement('input');
    e.addEventListener('focus', () => {
      e.select();
    });
    e.classList.add('neuroglancer-transfer-function-widget-bound');
    e.type = 'text';
    e.spellcheck = false;
    e.autocomplete = 'off';
    e.title = `${endpoint === 0 ? 'Lower' : 'Upper'} bound for transfer function range`;
    return e;
  }

  const container = document.createElement('div');
  container.classList.add('neuroglancer-transfer-function-range-bounds');
  const inputs = [createRangeBoundInput(0), createRangeBoundInput(1)];
  for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
    const input = inputs[endpointIndex];
    input.addEventListener('input', () => {
      updateInputBoundWidth(input);
    });
    input.addEventListener('change', () => {
      const existingBounds = model.value.range;
      const intervals = {range: existingBounds, window: existingBounds};
      try {
        const value = parseDataTypeValue(dataType, input.value);
        const range = getUpdatedRangeAndWindowParameters(
                          intervals, 'window', endpointIndex, value, /*fitRangeInWindow=*/ true)
                          .window;
        model.value = {...model.value, range};
      } catch {
        updateInputBoundValue(input, existingBounds[endpointIndex]);
      }
    });
  }
  container.appendChild(inputs[0]);
  container.appendChild(inputs[1]);
  return {
    container, inputs
  }
}

const inputEventMap = EventActionMap.fromObject({
  'shift?+mousedown0': {action: 'add-or-drag-point'},
  'shift?+dblclick0': {action: 'remove-point'},
  'shift?+mousedown2': {action: 'change-point-color'},
});

/**
 * Controller for the transfer function widget. Handles mouse events and updates to the model.
 */
class TransferFunctionController extends RefCounted {
  private currentGrabbedControlPointIndex: number = -1;
  constructor(
      public element: HTMLElement, public dataType: DataType,
      private controlPointsLookupTable: ControlPointsLookupTable,
      public getModel: () => TransferFunctionParameters,
      public setModel: (value: TransferFunctionParameters) => void) {
    super();
    element.title = inputEventMap.describe();
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    registerActionListener<MouseEvent>(element, 'add-or-drag-point', actionEvent => {
      const mouseEvent = actionEvent.detail;
      this.updateValue(this.addControlPoint(mouseEvent));
      startRelativeMouseDrag(mouseEvent, (newEvent: MouseEvent) => {
        this.updateValue(this.moveControlPoint(newEvent));
      });
    });
    registerActionListener<MouseEvent>(element, 'remove-point', actionEvent => {
      const mouseEvent = actionEvent.detail;
      const nearestIndex = this.findNearestControlPointIndex(mouseEvent);
      if (nearestIndex !== -1) {
        this.controlPointsLookupTable.trackable.value.controlPoints.splice(nearestIndex, 1);
        this.updateValue({...this.getModel(), controlPoints: this.controlPointsLookupTable.trackable.value.controlPoints});
      }
    });
    registerActionListener<MouseEvent>(element, 'change-point-color', actionEvent => {
      const mouseEvent = actionEvent.detail;
      const nearestIndex = this.findNearestControlPointIndex(mouseEvent);
      if (nearestIndex !== -1) {
        const color = this.controlPointsLookupTable.trackable.value.color;
        this.controlPointsLookupTable.setPointColor(nearestIndex, color);
        this.updateValue({...this.getModel(), controlPoints: this.controlPointsLookupTable.trackable.value.controlPoints});
      }
    });
  }
  updateValue(value: TransferFunctionParameters|undefined) {
    if (value === undefined) return;
    this.setModel(value);
  }
  findNearestControlPointIndex(event: MouseEvent) {
    const {normalizedX} = this.getControlPointPosition(event) as CanvasPosition;
    return this.controlPointsLookupTable.grabControlPoint(normalizedX);
  }
  addControlPoint(event: MouseEvent) : TransferFunctionParameters|undefined{
    const color = this.controlPointsLookupTable.trackable.value.color;
    const nearestIndex = this.findNearestControlPointIndex(event);
    if (nearestIndex !== -1) {
      this.currentGrabbedControlPointIndex = nearestIndex;
      // if (shouldChangeColor) {
      //   this.controlPointsLookupTable.setPointColor(this.currentGrabbedControlPointIndex, color);
      // }
      return undefined;
    } else {
      this.addPoint(event, color);
      this.currentGrabbedControlPointIndex = this.findNearestControlPointIndex(event);
      return {...this.getModel(), controlPoints: this.controlPointsLookupTable.trackable.value.controlPoints};
    }
  }
  addPoint(event: MouseEvent, color: vec3) {
    const {normalizedX, normalizedY} = this.getControlPointPosition(event) as CanvasPosition;
    this.controlPointsLookupTable.addPoint(normalizedX, normalizedY, color);
  }
  moveControlPoint(event: MouseEvent): TransferFunctionParameters|undefined {
    if (this.currentGrabbedControlPointIndex !== -1) {
      const position = this.getControlPointPosition(event);
      console.log(position);
      if (position === undefined) return undefined;
      const {normalizedX, normalizedY} = position;
      this.currentGrabbedControlPointIndex = this.controlPointsLookupTable.updatePoint(
          this.currentGrabbedControlPointIndex, normalizedX, normalizedY);
      return {...this.getModel(), controlPoints: this.controlPointsLookupTable.trackable.value.controlPoints};
    }
    return undefined;
  }
  getControlPointPosition(event: MouseEvent) : CanvasPosition|undefined {
    const clientRect = this.element.getBoundingClientRect();
    const normalizedX = (event.clientX - clientRect.left) / clientRect.width;
    const normalizedY = (clientRect.bottom - event.clientY) / clientRect.height;
    if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) return undefined;
    return {normalizedX, normalizedY};
  }
}

// TODO (skm) the widget needs to have a controller for bindings
/**
 * Widget for the transfer function. Creates the UI elements required for the transfer function.
 */
class TransferFunctionWidget extends Tab {
  private transferFunctionPanel = this.registerDisposer(new TransferFunctionPanel(this));

  range = createRangeBoundInputs(this.dataType, this.trackable);
  constructor(
      visibility: WatchableVisibilityPriority, public display: DisplayContext,
      public dataType: DataType,
      public trackable: WatchableValueInterface<TransferFunctionParameters>) {
    super(visibility);
    const {element} = this;
    element.classList.add('neuroglancer-transfer-function-widget');
    element.appendChild(this.transferFunctionPanel.element);

    // Range bounds element
    element.appendChild(this.range.container);
    this.range.container.dispatchEvent(new Event('change'))

    // Color picker element
    const colorPickerDiv = document.createElement('div');
    colorPickerDiv.classList.add('neuroglancer-transfer-function-color-picker');
    colorPickerDiv.addEventListener('mouseenter', (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      colorPicker.element.disabled = false;
    })
    colorPickerDiv.addEventListener('mouseleave', (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      colorPicker.element.disabled = true;
    })
    const colorPicker = this.registerDisposer(new ColorWidget(
        makeCachedDerivedWatchableValue((x: TransferFunctionParameters) => x.color, [trackable]),
        () => vec3.fromValues(1, 1, 1)));
    colorPicker.element.disabled = true;
    colorPicker.element.title = 'Transfer Function Color Picker'
    colorPicker.element.id = 'neuroglancer-tf-color-widget';
    colorPicker.element.addEventListener('change', () => {
      trackable.value = {...this.trackable.value, color: colorPicker.model.value};
    });
    colorPicker.element.addEventListener('input', () => {
      trackable.value = {...this.trackable.value, color: colorPicker.model.value};
    });
    colorPickerDiv.appendChild(colorPicker.element);

    const colorLabel = document.createElement('label');
    colorLabel.setAttribute('for', 'neuroglancer-tf-color-widget');
    colorPickerDiv.appendChild(colorLabel);
    element.appendChild(colorPickerDiv);
    this.updateControlPointsAndDraw();
    this.registerDisposer(this.trackable.changed.add(() => {
      this.updateControlPointsAndDraw();
    }));
    updateInputBoundValue(this.range.inputs[0], this.trackable.value.range[0]);
    updateInputBoundValue(this.range.inputs[1], this.trackable.value.range[1]);
  };
  updateView() {
    this.transferFunctionPanel.scheduleRedraw();
  }
  updateControlPointsAndDraw() {
    this.transferFunctionPanel.update();
    this.updateView();
  }
}
// TODO (skm) may need to follow the VariableDataTypeInvlerpWidget pattern

/**
 * Create a shader function for the transfer function to grab the nearest lookup table value
 */
export function defineTransferFunctionShader(
    builder: ShaderBuilder, name: string, dataType: DataType, channel: number[]) {
  builder.addUniform(`highp ivec4`, `uTransferFunctionParams_${name}`, TRANSFER_FUNCTION_LENGTH);
  builder.addUniform(`float`, `uTransferFunctionGridSize_${name}`);
  const invlerpShaderCode =
      defineInvlerpShaderFunction(builder, name, dataType, true) as ShaderCodePart[];
  const shaderType = getShaderType(dataType);
  // TODO (SKM) - bring in intepolation code option
  // TODO (SKM) - use invlerp code to help this
  let code = `
vec4 ${name}(float inputValue) {
  float gridMultiplier = uTransferFunctionGridSize_${name} - 1.0;
  int index = clamp(int(round(inputValue * gridMultiplier)), 0, int(gridMultiplier));
  return vec4(uTransferFunctionParams_${name}[index]) / 255.0;
}
vec4 ${name}(${shaderType} inputValue) {
  float v = computeInvlerp(inputValue, uLerpParams_${name});
  return ${name}(clamp(v, 0.0, 1.0));
}
vec4 ${name}() {
  if (!MAX_PROJECTION) {
    return ${name}(getInterpolatedDataValue(${channel.join(',')}));
  }
  else {
    float v = computeInvlerp(maxIntensity, uLerpParams_${name});
    return ${name}(clamp(v, 0.0, 1.0));
  }
}
`;
  return [invlerpShaderCode[0], invlerpShaderCode[1], invlerpShaderCode[2], code]
}

// TODO (skm) can likely optimize this
/**
 * Create a lookup table and bind that lookup table to a shader via uniforms
 */
export function enableTransferFunctionShader(
    shader: ShaderProgram, name: string, dataType: DataType, controlPoints: Array<ControlPoint>,
    interval: DataTypeInterval) {
  const {gl} = shader;
  const transferFunction = new Int32Array(TRANSFER_FUNCTION_LENGTH * NUM_COLOR_CHANNELS);
  lerpBetweenControlPoints(transferFunction, controlPoints);
  switch (dataType) {
    case DataType.UINT8:
    case DataType.UINT16:
    case DataType.INT8:
    case DataType.INT16:
    case DataType.FLOAT32:
      gl.uniform4iv(shader.uniform(`uTransferFunctionParams_${name}`), transferFunction);
      gl.uniform1f(shader.uniform(`uTransferFunctionGridSize_${name}`), TRANSFER_FUNCTION_LENGTH);
      gl.uniform2f(
          shader.uniform(`uLerpParams_${name}`), interval[0] as number,
          1 / ((interval[1] as number) - (interval[0] as number)));
      break;
    // TODO (skm) add support for other data types
    // TODO (skm) easiest way might be to use the invlerp function
    // TODO (skm) might be able to use a texture for this
    default:
      throw new Error(`Data type for transfer function not yet implemented: ${dataType}`);
  }
}

/**
 * Describe the transfer function widget in the popup window for a tool
 */
export function activateTransferFunctionTool(
    activation: ToolActivation<LayerControlTool>, control: TransferFunctionWidget) {
  activation.bindInputEventMap(inputEventMap);
  control;
}

/**
 * Create a layer control factory for the transfer function widget
 */
export function transferFunctionLayerControl<LayerType extends UserLayer>(
    getter: (layer: LayerType) => {
      watchableValue: WatchableValueInterface<TransferFunctionParameters>,
      dataType: DataType,
    }): LayerControlFactory<LayerType, TransferFunctionWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {watchableValue, dataType} = getter(layer);
      const control = context.registerDisposer(new TransferFunctionWidget(
          options.visibility, options.display, dataType, watchableValue));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activateTransferFunctionTool(activation, control);
    },
  };
}
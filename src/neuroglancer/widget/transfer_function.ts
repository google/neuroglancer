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
import {ToolActivation} from 'neuroglancer/ui/tool';
import {DataType} from 'neuroglancer/util/data_type';
import {ActionEvent, EventActionMap} from 'neuroglancer/util/event_action_map';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {defineLineShader, drawLines, initializeLineShader} from 'neuroglancer/webgl/lines';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {LayerControlFactory, LayerControlTool} from 'neuroglancer/widget/layer_control';
import {Tab} from 'neuroglancer/widget/tab_view';
import {UserLayer} from 'neuroglancer/layer';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4, vec3} from 'neuroglancer/util/geom';
import {computeLerp} from 'neuroglancer/util/lerp';
import {GL} from 'neuroglancer/webgl/context';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';
import {VERTICES_PER_QUAD} from 'neuroglancer/webgl/quad';
import {Buffer, getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {TransferFunctionParameters} from 'neuroglancer/webgl/shader_ui_controls';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';

// TODO (skm): remove hardcoded UINT8
const NUM_COLOR_CHANNELS = 4;
// const NUM_TF_LINES = 256;
const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'add-point'},
});
const transferFunctionSamplerTextureUnit = Symbol('transferFunctionSamplerTexture');

export interface ControlPoint {
  position: number;
  color: vec4;
}

export interface TransferFunctionTextureOptions {
  controlPoints: ControlPointsLookupTable;
  textureUnit: number;
}

function lerpUint8Color(startColor: vec4, endColor: vec4, t: number) {
  const color = vec4.create();
  for (let i = 0; i < 4; ++i) {
    color[i] = computeLerp([startColor[i], endColor[i]],DataType.UINT8, t) as number;
  }
  return color;
}

function griddedRectangleArray(numGrids: number) {
  const result = new Float32Array(numGrids * VERTICES_PER_QUAD * 2);
  const width = 2;
  const height = 1;
  let start = -width / 2;
  const step = width / numGrids;
  for (let i = 0; i < numGrids; ++i) {
    const end = start + step;
    const index = i * VERTICES_PER_QUAD * 2;
    
    // Triangle 1 - top-left, top-right, bottom-right
    result[index] = start; // top-left x
    result[index + 1] = height; // top-left y
    result[index + 2] = end // top-right x
    result[index + 3] = height; // top-right y
    result[index + 4] = end; // bottom-right x
    result[index + 5] = -height; // bottom-right y

    // Triangle 2 - top-left, bottom-right, bottom-left
    result[index + 6] = start; // top-left x
    result[index + 7] = height; // top-left y
    result[index + 8] = end; // bottom-right x
    result[index + 9] = -height; // bottom-right y
    result[index + 10] = start; // bottom-left x
    result[index + 11] = -height; // bottom-left y
    start += step;
  }
  return result;
}

class TransferFunctionTexture extends RefCounted {
  texture: WebGLTexture | null = null;
  width: number;
  height: number = 1;
  private priorOptions: TransferFunctionTextureOptions | undefined = undefined;

  constructor(public gl: GL, dataType: DataType) {
    super();
    switch (dataType) {
      case DataType.UINT8:
        this.width = 256;
        break;
      default:
        throw new Error('Invalid data type');
    }
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
    // TODO (skm) probably more efficient to pack the
    // 2D texture. I think there are some helper functions
    // to help with this.
    gl.texImage2D(WebGL2RenderingContext.TEXTURE_2D, 0, WebGL2RenderingContext.RGBA, this.width, 1, 0, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE, options.controlPoints.lookupTable);
    this.priorOptions = options;
  }

  disposed() {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
    super.disposed();
  }
}

class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: TransferFunctionTexture;
  private vertexBuffer: Buffer;
  get drawOrder() {
    return 1;
  }
  constructor(public parent: TransferFunctionWidget, public dataType: DataType) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-transfer-function-panel');
    this.texture = this.registerDisposer(new TransferFunctionTexture(this.gl, dataType));
    // TODO remove fixed 256
    this.vertexBuffer =
        this.registerDisposer(getMemoizedBuffer(
                                this.gl, WebGL2RenderingContext.ARRAY_BUFFER, griddedRectangleArray,
                                256)).value;
  }

  private lineShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    defineLineShader(builder);
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.setVertexMain(`
vec4 start = vec4(-1.0, 0.0, 0.0, 1.0);
vec4 end = vec4(1.0, 0.0, 0.0, 1.0);
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
    builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
vTexCoord = (aVertexPosition + 1.0) / 2.0;
`);
    builder.setFragmentMain(`
ivec2 texel = ivec2(floor(vTexCoord.x * 255.0), 0);
out_color = texelFetch(uSampler, texel, 0);
`);
    return builder.build();
  })());

  drawIndirect() {
    const {lineShader, gl, transferFunctionShader} = this;
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
      this.vertexBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2, /*attributeType=*/WebGL2RenderingContext.FLOAT);
      // const textureUnit = transferFunctionShader.textureUnit(this.texture.symbol);
      const textureUnit = transferFunctionShader.textureUnit(transferFunctionSamplerTextureUnit);

      this.texture.updateAndActivate({controlPoints: this.parent.controlPointsLookupTable, textureUnit});
      gl.drawArrays(gl.TRIANGLES, 0, 256 * VERTICES_PER_QUAD);
      gl.disableVertexAttribArray(aVertexPosition);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    }
    {
      const {renderViewport} = this;
      lineShader.bind();
      initializeLineShader(
        lineShader, {width: renderViewport.logicalWidth, height: renderViewport.logicalHeight},
          /*featherWidthInPixels=*/ 1.0);
      drawLines(gl, 1, 1)
    }
    gl.disable(WebGL2RenderingContext.BLEND);
  }

  isReady() {
    return true;
  }
}

class ControlPointsLookupTable extends RefCounted {
  lookupTable: Uint8Array;
  constructor(dataType: DataType, public trackable: WatchableValueInterface<TransferFunctionParameters>) {
    super();
    switch (dataType) {
      case DataType.UINT8:
        this.lookupTable = new Uint8Array(256 * NUM_COLOR_CHANNELS).fill(0);
        break;
      default:
        throw new Error('Invalid data type');
    }
  }

  positionToIndex(position: number) {
    return Math.floor(position * this.lookupTable.length / NUM_COLOR_CHANNELS);
  }

  addPoint(position: number, opacity: number, color: vec3) {
    const controlPoints = this.trackable.value.controlPoints;
    const positionAsIndex = this.positionToIndex(position);
    // TODO temporary to ensure no duplicate positions
    const existingIndex = controlPoints.findIndex((point) => point.position === positionAsIndex);
    if (existingIndex !== -1) {
      controlPoints.splice(existingIndex, 1);
    }
    controlPoints.push({position: positionAsIndex, color: vec4.fromValues(color[0], color[1], color[2], opacity)});
    controlPoints.sort((a, b) => a.position - b.position);
  }

  lookupTableFromControlPoints() {
    // TODO (skm) implement change based on data type
    const {lookupTable} = this;
    const {controlPoints} = this.trackable.value;

    function addLookupValue(index: number, color: vec4) {
      lookupTable[index] = color[0];
      lookupTable[index + 1] = color[1];
      lookupTable[index + 2] = color[2];
      lookupTable[index + 3] = color[3];
    }

    if (controlPoints.length === 0) {
      this.lookupTable.fill(0);
      return;
    }
    const firstPoint = controlPoints[0];

    if (firstPoint.position > 0) {
      const {color} = controlPoints[0];
      for (let i = 0; i < firstPoint.position; ++i) {
        const t = i / firstPoint.position;
        const lerpedColor = lerpUint8Color(vec4.fromValues(0, 0, 0, 0), color, t);
        const index = i * NUM_COLOR_CHANNELS;
        addLookupValue(index, lerpedColor);
      }
    }

    let controlPointIndex = 0;
    for (let i = firstPoint.position; i < 256; ++i) {
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

  // TODO (skm) correct disposal
  disposed() {
    super.disposed();
  }
}

export class TransferFunctionWidget extends Tab {
  transferFunctionPanel = this.registerDisposer(new TransferFunctionPanel(this, this.dataType));
  controlPointsLookupTable = this.registerDisposer(new ControlPointsLookupTable(this.dataType, this.trackable));
  constructor(visibility: WatchableVisibilityPriority, public display: DisplayContext, public dataType: DataType, public trackable: WatchableValueInterface<TransferFunctionParameters>) {
    super(visibility);
    const {element} = this;
    element.appendChild(this.transferFunctionPanel.element);
    element.classList.add('neuroglancer-transfer-function-widget');
    this.updateView();
    element.addEventListener('mousedown', (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      this.addPoint(event, element.clientWidth, element.clientHeight);
    })
    // TODO (skm) add color picker
  };

  updateView() {
    this.transferFunctionPanel.scheduleRedraw();
  }
  addPoint(event: MouseEvent, canvasX: number, canvasY: number) {
    const normalizedX = event.offsetX / canvasX;
    const normalizedY = 1 - (event.offsetY / canvasY);
    const opacity = Math.round(normalizedY * 255)
    // TODO (skm) add color picker
    this.controlPointsLookupTable.addPoint(normalizedX, opacity, vec3.fromValues(255, 255, 255));
    this.controlPointsLookupTable.lookupTableFromControlPoints();
    this.updateView();
  }
}

export function defineTransferFunctionShader(builder: ShaderBuilder, name: string, controlPoints: Array<ControlPoint>) {
  controlPoints;
  builder;
  let code = `
vec4 ${name}(float inputValue) {
  return vec4(0.0, 0.0, 0.0, 0.0);
}
`;
  return code
}

export function activateTransferFunctionTool(
  activation: ToolActivation<LayerControlTool>, control: TransferFunctionWidget) {
  activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
  activation.bindAction('add-point', (event: ActionEvent<MouseEvent>) => {
    event.stopPropagation();
    event.preventDefault();
    control.addPoint(event.detail, control.element.clientWidth, control.element.clientHeight);
  });
}

export function transferFunctionLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    watchableValue: WatchableValueInterface<TransferFunctionParameters>,
    dataType: DataType,
  }): LayerControlFactory<LayerType, TransferFunctionWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {watchableValue, dataType} = getter(layer);
      const control =
        context.registerDisposer(new TransferFunctionWidget(options.visibility, options.display, dataType, watchableValue));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activateTransferFunctionTool(activation, control);
    },
  };
}
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
import {UserLayer} from 'src/neuroglancer/layer';
import {RefCounted} from 'src/neuroglancer/util/disposable';
import {vec4, vec3} from 'src/neuroglancer/util/geom';
import {GL} from 'src/neuroglancer/webgl/context';
import {getSquareCornersBuffer} from 'src/neuroglancer/webgl/square_corners_buffer';
import {setRawTextureParameters} from 'src/neuroglancer/webgl/texture';

// TODO (skm): remove hardcoded UINT8
const DATA_TYPE = DataType.UINT8;
const NUM_COLOR_CHANNELS = 4;
// const NUM_TF_LINES = 256;
const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'add-point'},
});
export const transferFunctionSamplerTextureUnit = Symbol('transferFunctionSamplerTexture');

export interface ControlPoint {
  position: number;
  color: vec4;
}

export interface TransferFunctionTextureOptions {
  controlPoints: ControlPoints;
  textureUnit: number;
}

export class TransferFunctionTexture extends RefCounted {
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
    // TODO probably more efficient to pack the
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

export class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: TransferFunctionTexture;
  get drawOrder() {
    return 1;
  }
  constructor(public parent: TransferFunctionWidget, public dataType: DataType) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-transfer-function-panel');
    this.texture = this.registerDisposer(new TransferFunctionTexture(this.gl, dataType));
  }

  private cornersBuffer = getSquareCornersBuffer(this.gl);

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
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.addTextureSampler('sampler2D', 'uSampler', transferFunctionSamplerTextureUnit);
    builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
`);
    builder.setFragmentMain(`
out_color = texelFetch(uSampler, ivec2(3, 0), 0);
`);
    return builder.build();
  })());

  drawIndirect() {
    console.log('draw indirect for transfer function')
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
      this.cornersBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2, /*attributeType=*/WebGL2RenderingContext.FLOAT);
      const textureUnit = transferFunctionShader.textureUnit(transferFunctionSamplerTextureUnit);

      this.texture.updateAndActivate({controlPoints: this.parent.controlPoints, textureUnit});
      gl.drawArrays(WebGL2RenderingContext.TRIANGLE_FAN, 0, 4);
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

class ControlPoints extends RefCounted {
  controlPoints = Array<ControlPoint>();
  lookupTable: Uint8Array;
  constructor(dataType: DataType) {
    super();
    switch (dataType) {
      case DataType.UINT8:
        this.lookupTable = new Uint8Array(256 * NUM_COLOR_CHANNELS).fill(0);
        break;
      default:
        throw new Error('Invalid data type');
    }
  }

  addPoint(x: number, opacity: number, color: vec3) {
    this.controlPoints.push({position: x, color: vec4.fromValues(color[0], color[1], color[2], opacity)});
    this.controlPoints.sort((a, b) => a.position - b.position);
  }

  lookupTableFromControlPoints() {
    // TODO (skm) implement change based on data type
    const {lookupTable, controlPoints} = this;

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

    if (controlPoints.length === 1) {
      const {position, color} = controlPoints[0];
      for (let i = position; i < 256; ++i) {
        // TODO (skm) handle x non-int
        const index = i * NUM_COLOR_CHANNELS;
        addLookupValue(index, color);
      }
      return;
    }

    const firstPoint = controlPoints[0];
    let controlPointIndex = 0;
    for (let i = firstPoint.position; i < 256; ++i) {
      const currentPoint = controlPoints[controlPointIndex];
      const nextPoint = controlPoints[controlPointIndex + 1];
      if (i < nextPoint.position) {
        const t = (i - currentPoint.position) / (nextPoint.position - currentPoint.position);
        const index = i * NUM_COLOR_CHANNELS;
        const lerpedColor = vec4.create();
        vec4.lerp(lerpedColor, currentPoint.color, nextPoint.color, t);
        addLookupValue(index, lerpedColor);
      } else {
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
  transferFunctionPanel = this.registerDisposer(new TransferFunctionPanel(this, DATA_TYPE));
  // TODO variable data type
  controlPoints = this.registerDisposer(new ControlPoints(DATA_TYPE));
  constructor(visibility: WatchableVisibilityPriority, public display: DisplayContext) {
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
    // TODO (skm) add color picker
    this.controlPoints.addPoint(normalizedX, normalizedY, vec3.fromValues(1, 1, 1));
    this.controlPoints.lookupTableFromControlPoints();
    this.updateView();
  }
}

export function defineTransferFunctionShader(builder: ShaderBuilder, name: string) {
  builder.addTextureSampler('sampler2D', 'uTransferSampler', transferFunctionSamplerTextureUnit);
  let code = `
vec4 ${name}(float inputValue) {
  int index = int(inputValue);
  return texelFetch(uTransferSampler, ivec2(index, 0), 0);
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
  getter: (layer: LayerType) => void): LayerControlFactory<LayerType, TransferFunctionWidget> {
  return {
    makeControl: (layer, context, options) => {
      getter(layer);
      const control =
        context.registerDisposer(new TransferFunctionWidget(options.visibility, options.display));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activateTransferFunctionTool(activation, control);
    },
  };
}
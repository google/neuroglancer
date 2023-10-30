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
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderCodePart} from 'neuroglancer/webgl/shader';
import {LayerControlFactory, LayerControlTool} from 'neuroglancer/widget/layer_control';
import {Tab} from 'neuroglancer/widget/tab_view';
import {UserLayer} from 'src/neuroglancer/layer';
import {RefCounted} from 'src/neuroglancer/util/disposable';
import {vec4, vec3} from 'src/neuroglancer/util/geom';
import {computeLerp} from 'src/neuroglancer/util/lerp';
import {GL} from 'src/neuroglancer/webgl/context';
import {getSquareCornersBuffer} from 'src/neuroglancer/webgl/square_corners_buffer';
import {setRawTextureParameters} from 'src/neuroglancer/webgl/texture';

// TODO (skm): remove hardcoded UINT8
const DATA_TYPE = DataType.UINT8;
// const NUM_TF_LINES = 256;
const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'add-point'},
});
export const transferFunctionSamplerTextureUnit = Symbol('transferFunctionSamplerTexture');

export interface ControlPoint {
  x: number;
  color: vec4;
}

export interface TransferFunctionTextureOptions {
  controlPoints: Map<number, vec4>;
}

export class TransferFunctionTexture extends RefCounted {
  texture: WebGLTexture|null = null;
  width = 0;
  height = 0;
  label = '';
  factor = 1;
  private priorOptions: TransferFunctionTextureOptions|undefined = undefined;
  private prevLabel: string = '';

  constructor(public gl: GL) {
    super();
  }

  update(options: TransferFunctionTextureOptions) {
    const {label} = this;
    let {texture} = this;
    if (texture !== null && options === this.priorOptions && label == this.prevLabel) {
      return;
    }
    if (texture === null) {
      texture = this.texture = this.gl.createTexture();
    }
    const {width, height} = makeTransferFunctionTexture(this.gl, texture, label, options);
    this.priorOptions = options;
    this.prevLabel = label;
    this.width = width;
    this.height = height;
  }

  disposed() {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
    super.disposed();
  }
}

function makeTransferFunctionTexture(gl: GL, texture: WebGLTexture|null, label: string, options: TransferFunctionTextureOptions): {width: number, height: number} {
  const {controlPoints} = options;
  const dataType = DATA_TYPE;
  switch (dataType) {
    case DataType.UINT8:
      const textureValues = new Uint8Array(4 * 256);
      break;
    default:
      throw new Error('Invalid data type');
  }
  for (let i = 0; i < controlPoints.size - 1; ++i) {
    const start_index = controlPoints.get()[i];
  
  
  }

}

function colorLerp(a: vec4, b: vec4, t: number, dataType: DataType) {
  for (let i = 0; i < 4; ++i) {
    const lerpedValue = computeLerp([a[i], b[i]], dataType, t);
  }
}




export class TransferFunctionPanel extends IndirectRenderedPanel {
  texture: WebGLTexture;
  get drawOrder() {
    return 1;
  }
  constructor(public parent: TransferFunctionWidget) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    this.texture = this.registerDisposer(this.gl.createTexture());
    element.classList.add('neuroglancer-transfer-function-panel');
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

  private tempTextureArray = new Uint8Array([
    255, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255
  ]);

  // private pixelBuffer = this.registerDisposer(
  //   getMemoizedBuffer(this.gl, WebGL2RenderingContext.PIXEL_UNPACK_BUFFER, () => this.tempTextureArray)).value;

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
      this.cornersBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2, /*attributeType=*/WebGL2RenderingContext.FLOAT);
      const textureUnit = transferFunctionShader.textureUnit(transferFunctionSamplerTextureUnit);

      const texture = gl.createTexture();
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setRawTextureParameters(gl);
      gl.texImage2D(WebGL2RenderingContext.TEXTURE_2D, 0, WebGL2RenderingContext.RGBA, 4, 1, 0, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE, this.tempTextureArray);
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
  constructor(dataType: DataType) {
    super();
    switch (dataType) {
      case DataType.UINT8:
        break;
      default:
        throw new Error('Invalid data type');
    }
  }

  addPoint(x: number, opacity: number, color: vec3) {
    this.controlPoints.push({x, vec4.fromValues(color[0], color[1], color[2], opacity)});
  }
  
  // TODO (skm) correct disposal
  disposed() {
    super.disposed();
  }
}

export class TransferFunctionWidget extends Tab {
  transferFunctionPanel = this.registerDisposer(new TransferFunctionPanel(this));
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
      console.log(event)
      console.log(element)
      this.addPoint(event, element.clientWidth, element.clientHeight);
    })
  };

  updateView() {
    this.transferFunctionPanel.scheduleRedraw();
  }
  addPoint(event: MouseEvent, canvasX: number, canvasY: number) {
    const normalizedX = event.offsetX / canvasX;
    const normalizedY = event.offsetY / canvasY;
    // TODO (skm) add color picker
    this.controlPoints.addPoint(normalizedX, normalizedY, vec3.fromValues(1, 1, 1));
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
    control.addPoint();
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
/**
 * @license
 * Copyright 2020 Google Inc.
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

import './invlerp.css';

import svg_arrowLeft from 'ikonate/icons/arrow-left.svg';
import svg_arrowRight from 'ikonate/icons/arrow-right.svg';
import {DisplayContext, RenderedPanel} from 'neuroglancer/display_context';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {DataType} from 'neuroglancer/util/data_type';
import {updateInputFieldWidth} from 'neuroglancer/util/dom';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {Uint64} from 'neuroglancer/util/uint64';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {ParameterizedEmitterDependentShaderGetter, parameterizedEmitterDependentShaderGetter} from 'neuroglancer/webgl/dynamic_shader';
import {HistogramSpecifications} from 'neuroglancer/webgl/empirical_cdf';
import {computeInvlerp, computeLerp, dataTypeCompare, DataTypeInterval, defineLerpShaderFunction, enableLerpShaderFunction, getClampedInterval, getClosestEndpoint, getIntervalBoundsEffectiveFraction, getIntervalBoundsEffectiveOffset, parseDataTypeValue} from 'neuroglancer/webgl/lerp';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {InvlerpParameters, ShaderInvlerpControl} from 'neuroglancer/webgl/shader_ui_controls';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';
import {makeIcon} from 'neuroglancer/widget/icon';
import {LegendShaderOptions, ShaderControlsOptions} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const inputEventMap = EventActionMap.fromObject({
  'mousedown0': {action: 'set'},
  'shift+mousedown0': {action: 'adjust-window-via-drag'},
  'wheel': {action: 'zoom-via-wheel'},
});

const histogramSamplerTextureUnit = Symbol('histogramSamplerTexture');

function getUpdatedParameters(
    existingBounds: InvlerpParameters, boundType: 'range'|'window', endpointIndex: number,
    newEndpoint: number|Uint64, fitRangeInWindow = false) {
  const newBounds = {...existingBounds};
  const existingInterval = existingBounds[boundType];
  newBounds[boundType] = [existingInterval[0], existingInterval[1]] as DataTypeInterval;
  newBounds[boundType][endpointIndex] = newEndpoint;
  if (boundType === 'window' &&
      dataTypeCompare(newEndpoint, existingInterval[1 - endpointIndex]) * (2 * endpointIndex - 1) <
          0) {
    newBounds[boundType][1 - endpointIndex] = newEndpoint;
  }
  if (boundType === 'range' && fitRangeInWindow) {
    // Also adjust `window` endpoint to contain the new endpoint.
    const newWindowInterval =
        [existingBounds.window[0], existingBounds.window[1]] as DataTypeInterval;
    for (let i = 0; i < 2; ++i) {
      if (dataTypeCompare(newEndpoint, newWindowInterval[i]) * (2 * i - 1) > 0) {
        newWindowInterval[i] = newEndpoint;
      }
    }
    newBounds.window = newWindowInterval;
  }
  return newBounds;
}

// 256 bins in total.  The first and last bin are for values below the lower bound/above the upper
// bound.
const NUM_HISTOGRAM_BINS_IN_RANGE = 254;
const NUM_CDF_LINES = NUM_HISTOGRAM_BINS_IN_RANGE + 1;

class CdfPanel extends RenderedPanel {
  get drawOrder() {
    return 100;
  }
  constructor(public parent: InvlerpWidget) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-invlerp-cdfpanel');
    element.title = inputEventMap.describe();
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    registerActionListener<MouseEvent>(element, 'set', actionEvent => {
      const mouseEvent = actionEvent.detail;
      const {trackable: {value: bounds}} = this.parent;
      const value = this.getTargetValue(mouseEvent);
      const clampedRange = getClampedInterval(bounds.window, bounds.range);
      const endpoint = getClosestEndpoint(clampedRange, value);
      const setEndpoint = (value: number|Uint64) => {
        const {trackable: {value: bounds}} = this.parent;
        this.parent.trackable.value = getUpdatedParameters(bounds, 'range', endpoint, value);
      };
      setEndpoint(value);
      startRelativeMouseDrag(mouseEvent, (newEvent: MouseEvent) => {
        const value = this.getTargetValue(newEvent);
        setEndpoint(value);
      });
    });

    registerActionListener<MouseEvent>(element, 'adjust-window-via-drag', actionEvent => {
      // If user starts drag on left half, then right bound is fixed, and left bound is adjusted to
      // keep the value under the mouse fixed.  If user starts drag on right half, the left bound is
      // fixed and right bound is adjusted.
      const mouseEvent = actionEvent.detail;
      const initialRelativeX = this.getTargetFraction(mouseEvent);
      const initialValue = this.getWindowLerp(initialRelativeX);
      const endpointIndex = (initialRelativeX < 0.5) ? 0 : 1;
      const setEndpoint = (value: number|Uint64) => {
        const {trackable: {value: bounds}} = this.parent;
        this.parent.trackable.value = getUpdatedParameters(bounds, 'window', endpointIndex, value);
      };
      startRelativeMouseDrag(mouseEvent, (newEvent: MouseEvent) => {
        const {trackable: {value: {window}}} = this.parent;
        const relativeX = this.getTargetFraction(newEvent);
        if (endpointIndex === 0) {
          // Need to find x such that: lerp([x, window[1]], relativeX) == initialValue
          // Equivalently: lerp([initialValue, window[1]], -relativeX / ( 1 - relativeX))
          setEndpoint(computeLerp(
              [initialValue, window[1]] as DataTypeInterval, this.parent.dataType,
              -relativeX / (1 - relativeX)));
        } else {
          // Need to find x such that: lerp([window[0], x], relativeX) == initialValue
          // Equivalently: lerp([window[0], initialValue], 1 / relativeX)
          setEndpoint(computeLerp(
              [window[0], initialValue] as DataTypeInterval, this.parent.dataType, 1 / relativeX));
        }
      });
    });

    registerActionListener<WheelEvent>(element, 'zoom-via-wheel', actionEvent => {
      const wheelEvent = actionEvent.detail;
      const zoomAmount = getWheelZoomAmount(wheelEvent);
      const relativeX = this.getTargetFraction(wheelEvent);
      const {dataType, trackable: {value: bounds}} = this.parent;
      const newLower = computeLerp(bounds.window, dataType, relativeX * (1 - zoomAmount));
      const newUpper =
          computeLerp(bounds.window, dataType, (1 - relativeX) * zoomAmount + relativeX);
      this.parent.trackable.value = {
        window: [newLower, newUpper] as DataTypeInterval,
        range: bounds.range,
        channel: bounds.channel,
      };
    });
  }

  getTargetFraction(event: MouseEvent) {
    const clientRect = this.element.getBoundingClientRect();
    return (event.clientX - clientRect.left) / clientRect.width;
  }

  getWindowLerp(relativeX: number) {
    const {parent} = this;
    return computeLerp(parent.trackable.value.window, parent.dataType, relativeX);
  }

  getTargetValue(event: MouseEvent) {
    return this.getWindowLerp(this.getTargetFraction(event));
  }

  private dataValuesBuffer =
      this.registerDisposer(getMemoizedBuffer(this.gl, WebGL2RenderingContext.ARRAY_BUFFER, () => {
            const array = new Uint8Array(NUM_CDF_LINES * VERTICES_PER_LINE);
            for (let i = 0; i < NUM_CDF_LINES; ++i) {
              for (let j = 0; j < VERTICES_PER_LINE; ++j) {
                array[i * VERTICES_PER_LINE + j] = i;
              }
            }
            return array;
          })).value;

  private lineShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    defineLineShader(builder);
    builder.addTextureSampler('sampler2D', 'uHistogramSampler', histogramSamplerTextureUnit);
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.addAttribute('uint', 'aDataValue');
    builder.addUniform('float', 'uBoundsFraction');
    builder.addVertexCode(`
float getCount(int i) {
  return texelFetch(uHistogramSampler, ivec2(i, 0), 0).x;
}
vec4 getVertex(float cdf, int i) {
  float x;
  if (i == 0) {
    x = -1.0;
  } else if (i == 255) {
    x = 1.0;
  } else {
    x = float(i) / 254.0 * uBoundsFraction * 2.0 - 1.0;
  }
  return vec4(x, cdf * (2.0 - uLineParams.y) - 1.0 + uLineParams.y * 0.5, 0.0, 1.0);
}
`);
    builder.setVertexMain(`
int lineNumber = int(aDataValue);
int dataValue = lineNumber;
float cumSum = 0.0;
for (int i = 0; i <= dataValue; ++i) {
  cumSum += getCount(i);
}
float total = cumSum + getCount(dataValue + 1);
float cumSumEnd = dataValue == ${NUM_CDF_LINES-1} ? cumSum : total;
if (dataValue == ${NUM_CDF_LINES-1}) {
  cumSum + getCount(dataValue + 1);
}
for (int i = dataValue + 2; i < 256; ++i) {
  total += getCount(i);
}
total = max(total, 1.0);
float cdf1 = cumSum / total;
float cdf2 = cumSumEnd / total;
emitLine(getVertex(cdf1, lineNumber), getVertex(cdf2, lineNumber + 1), 1.0);
`);
    builder.setFragmentMain(`
out_color = vec4(0.0, 1.0, 1.0, getLineAlpha());
`);
    return builder.build();
  })());

  private regionCornersBuffer = getSquareCornersBuffer(this.gl, 0, -1, 1, 1);

  private regionShader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    builder.addAttribute('vec2', 'aVertexPosition');
    builder.addUniform('vec2', 'uBounds');
    builder.addUniform('vec4', 'uColor');
    builder.addOutputBuffer('vec4', 'out_color', 0);
    builder.setVertexMain(`
gl_Position = vec4(mix(uBounds[0], uBounds[1], aVertexPosition.x) * 2.0 - 1.0, aVertexPosition.y, 0.0, 1.0);
`);
    builder.setFragmentMain(`
out_color = uColor;
`);
    return builder.build();
  })());

  draw() {
    const {lineShader, gl, regionShader, parent: {dataType, trackable: {value: bounds}}} = this;
    this.setGLLogicalViewport();
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.disable(WebGL2RenderingContext.STENCIL_TEST);
    {
      regionShader.bind();
      gl.uniform4f(regionShader.uniform('uColor'), 0.2, 0.2, 0.2, 1.0);
      const fraction0 = computeInvlerp(bounds.window, bounds.range[0]),
            fraction1 = computeInvlerp(bounds.window, bounds.range[1]);
      const effectiveFraction = getIntervalBoundsEffectiveFraction(dataType, bounds.window);
      gl.uniform2f(
          regionShader.uniform('uBounds'), Math.min(fraction0, fraction1) * effectiveFraction,
          Math.max(fraction0, fraction1) * effectiveFraction + (1 - effectiveFraction));
      const aVertexPosition = regionShader.attribute('aVertexPosition');
      this.regionCornersBuffer.bindToVertexAttrib(
          aVertexPosition, /*componentsPerVertexAttribute=*/ 2,
          /*attributeType=*/ WebGL2RenderingContext.FLOAT);
      gl.drawArrays(WebGL2RenderingContext.TRIANGLE_FAN, 0, 4);
      gl.disableVertexAttribArray(aVertexPosition);
    }
    if (this.parent.histogramSpecifications.producerVisibility.visible) {
      const {renderViewport} = this;
      lineShader.bind();
      initializeLineShader(
          lineShader, {width: renderViewport.logicalWidth, height: renderViewport.logicalHeight},
          /*featherWidthInPixels=*/ 1.0);
      const histogramTextureUnit = lineShader.textureUnit(histogramSamplerTextureUnit);
      gl.uniform1f(
          lineShader.uniform('uBoundsFraction'),
          getIntervalBoundsEffectiveFraction(dataType, bounds.window));
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + histogramTextureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, this.parent.texture);
      setRawTextureParameters(gl);
      const aDataValue = lineShader.attribute('aDataValue');
      this.dataValuesBuffer.bindToVertexAttribI(
          aDataValue, /*componentsPerVertexAttribute=*/ 1,
          /*attributeType=*/ WebGL2RenderingContext.UNSIGNED_BYTE);
      drawLines(gl, /*linesPerInstance=*/ NUM_CDF_LINES, /*numInstances=*/ 1);
      gl.disableVertexAttribArray(aDataValue);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    }
    gl.disable(WebGL2RenderingContext.BLEND);
  }

  isReady() {
    return true;
  }
}

function dummyColorLegendShaderModule() {}

class ColorLegendPanel extends RenderedPanel {
  private shaderOptions: LegendShaderOptions;
  constructor(public parent: InvlerpWidget) {
    super(parent.display, document.createElement('div'), parent.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-invlerp-legend-panel');
    const shaderOptions = this.shaderOptions = parent.shaderControlsOptions.legendShaderOptions!;
    this.shaderGetter = parameterizedEmitterDependentShaderGetter(this, this.gl, {
      ...shaderOptions,
      memoizeKey: {id: `colorLegendShader`, base: shaderOptions.memoizeKey},
      defineShader: (builder, parameters, extraParameters) => {
        builder.addOutputBuffer('vec4', 'v4f_fragData0', 0);
        builder.addAttribute('vec2', 'aVertexPosition');
        builder.addUniform('float', 'uLegendOffset');
        builder.addVarying('float', 'vLinearPosition');
        builder.setVertexMain(`
gl_Position = vec4(aVertexPosition, 0.0, 1.0);
vLinearPosition = -uLegendOffset + ((aVertexPosition.x + 1.0) * 0.5) * (1.0 + 2.0 * uLegendOffset);
`);
        const dataType = this.parent.dataType;
        const shaderDataType = getShaderType(dataType);
        builder.addFragmentCode(defineLerpShaderFunction(builder, 'ng_colorLegendLerp', dataType));
        builder.addFragmentCode(`
void emit(vec4 v) {
  v4f_fragData0 = v;
}
${shaderDataType} getDataValue() {
  return ng_colorLegendLerp(vLinearPosition);
}
${shaderDataType} getDataValue(int dummyChannel) {
  return getDataValue();
}
${shaderDataType} getInterpolatedDataValue() {
  return getDataValue();
}
${shaderDataType} getInterpolatedDataValue(int dummyChannel) {
  return getDataValue();
}
`);
        shaderOptions.defineShader(builder, parameters, extraParameters);
      },
    });
  }

  private shaderGetter: ParameterizedEmitterDependentShaderGetter;

  private cornersBuffer = getSquareCornersBuffer(this.gl, -1, -1, 1, 1);

  draw() {
    const shaderResult = this.shaderGetter(dummyColorLegendShaderModule);
    const {shader} = shaderResult;
    if (shader === null) return;
    this.setGLLogicalViewport();
    shader.bind();
    this.shaderOptions.initializeShader(shaderResult);
    const {gl} = this;
    gl.enable(WebGL2RenderingContext.BLEND);
    const {trackable: {value: {window}}, dataType} = this.parent;
    enableLerpShaderFunction(shader, 'ng_colorLegendLerp', this.parent.dataType, window);
    const legendOffset = getIntervalBoundsEffectiveOffset(dataType, window);
    gl.uniform1f(shader.uniform('uLegendOffset'), Number.isFinite(legendOffset) ? legendOffset : 0);
    gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.disable(WebGL2RenderingContext.STENCIL_TEST);
    const aVertexPosition = shader.attribute('aVertexPosition');
    this.cornersBuffer.bindToVertexAttrib(
        aVertexPosition, /*componentsPerVertexAttribute=*/ 2,
        /*attributeType=*/ WebGL2RenderingContext.FLOAT);
    gl.drawArrays(WebGL2RenderingContext.TRIANGLE_FAN, 0, 4);
    gl.disableVertexAttribArray(aVertexPosition);
  }

  isReady() {
    return true;
  }
}

function createRangeBoundInput(boundType: 'range'|'window', endpoint: number) {
  const e = document.createElement('input');
  e.addEventListener('focus', () => {
    e.select();
  });
  e.classList.add('neuroglancer-invlerp-widget-bound');
  e.classList.add(`neuroglancer-invlerp-widget-${boundType}-bound`);
  e.type = 'text';
  e.spellcheck = false;
  e.autocomplete = 'off';
  e.title = boundType === 'range' ? `Data value that maps to ${endpoint}` :
                                    `${endpoint === 0 ? 'Lower' : 'Upper'} bound for distribution`;
  return e;
}

function createRangeBoundInputs(
    boundType: 'range'|'window', dataType: DataType,
    model: WatchableValueInterface<InvlerpParameters>) {
  const container = document.createElement('div');
  container.classList.add('neuroglancer-invlerp-widget-bounds');
  container.classList.add(`neuroglancer-invlerp-widget-${boundType}-bounds`);
  const inputs = [
    createRangeBoundInput(boundType, 0), createRangeBoundInput(boundType, 1)
  ] as [HTMLInputElement, HTMLInputElement];
  for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
    const input = inputs[endpointIndex];
    input.addEventListener('input', () => {
      updateInputBoundWidth(input);
    });
    input.addEventListener('change', () => {
      const existingBounds = model.value;
      const existingInterval = existingBounds[boundType];
      try {
        const value = parseDataTypeValue(dataType, input.value);
        model.value = getUpdatedParameters(
            existingBounds, boundType, endpointIndex, value, /*fitRangeInWindow=*/ true);
      } catch {
        updateInputBoundValue(input, existingInterval[endpointIndex]);
      }
    });
  }
  let spacers: [HTMLElement, HTMLElement, HTMLElement]|undefined;
  container.appendChild(inputs[0]);
  container.appendChild(inputs[1]);
  if (boundType === 'range') {
    spacers = [
      document.createElement('div'),
      document.createElement('div'),
      document.createElement('div'),
    ];
    spacers[1].classList.add('neuroglancer-invlerp-widget-range-spacer');
    container.insertBefore(spacers[0], inputs[0]);
    container.insertBefore(spacers[1], inputs[1]);
    container.appendChild(spacers[2]);
  }
  return {container, inputs, spacers};
}

function updateInputBoundWidth(inputElement: HTMLInputElement) {
  updateInputFieldWidth(inputElement, Math.max(1, inputElement.value.length + 0.1));
}

function updateInputBoundValue(inputElement: HTMLInputElement, bound: number|Uint64) {
  let boundString: string;
  if (bound instanceof Uint64 || Number.isInteger(bound)) {
    boundString = bound.toString();
  } else {
    boundString = bound.toPrecision(6);
  }
  inputElement.value = boundString;
  updateInputBoundWidth(inputElement);
}

export class InvlerpWidget extends Tab {
  cdfPanel = this.registerDisposer(new CdfPanel(this));
  boundElements = {
    range: createRangeBoundInputs('range', this.dataType, this.trackable),
    window: createRangeBoundInputs('window', this.dataType, this.trackable),
  };
  invertArrows: HTMLElement[];
  get texture() {
    return this.histogramSpecifications.getFramebuffers(this.display.gl)[this.histogramIndex]
        .colorBuffers[0]
        .texture;
  }
  get dataType() {
    return this.control.dataType;
  }
  private invertRange() {
    const {trackable} = this;
    const bounds = trackable.value;
    const {range} = bounds;
    trackable.value = {...bounds, range: [range[1], range[0]] as DataTypeInterval};
  }
  constructor(
      visibility: WatchableVisibilityPriority, public display: DisplayContext,
      public control: ShaderInvlerpControl,
      public trackable: WatchableValueInterface<InvlerpParameters>,
      public histogramSpecifications: HistogramSpecifications, public histogramIndex: number,
      public shaderControlsOptions: ShaderControlsOptions) {
    super(visibility);
    this.registerDisposer(histogramSpecifications.visibility.add(this.visibility));
    const {element, boundElements} = this;
    if (control.default.channel.length === 0 &&
        shaderControlsOptions.legendShaderOptions !== undefined) {
      const legendPanel = this.registerDisposer(new ColorLegendPanel(this));
      element.appendChild(legendPanel.element);
    }
    const makeArrow = (svg: string) => {
      const icon = makeIcon({
        svg,
        title: 'Invert range',
        onClick: () => {
          this.invertRange();
        },
      });
      boundElements.range.spacers![1].appendChild(icon);
      return icon;
    };
    this.invertArrows = [makeArrow(svg_arrowRight), makeArrow(svg_arrowLeft)];
    element.appendChild(boundElements.range.container);
    element.appendChild(this.cdfPanel.element);
    element.classList.add('neuroglancer-invlerp-widget');
    element.appendChild(boundElements.window.container);
    this.updateView();
    this.registerDisposer(trackable.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));
  }

  updateView() {
    const {boundElements} = this;
    const {trackable: {value: bounds}, dataType} = this;
    for (let i = 0; i < 2; ++i) {
      updateInputBoundValue(boundElements.range.inputs[i], bounds.range[i]);
      updateInputBoundValue(boundElements.window.inputs[i], bounds.window[i]);
    }
    const reversed = dataTypeCompare(bounds.range[0], bounds.range[1]) > 0;
    boundElements.range.container.style.flexDirection = !reversed ? 'row' : 'row-reverse';
    const clampedRange = getClampedInterval(bounds.window, bounds.range);
    const spacers = boundElements.range.spacers!;
    const effectiveFraction = getIntervalBoundsEffectiveFraction(dataType, bounds.window);
    const leftOffset =
        computeInvlerp(bounds.window, clampedRange[reversed ? 1 : 0]) * effectiveFraction;
    const rightOffset =
        computeInvlerp(bounds.window, clampedRange[reversed ? 0 : 1]) * effectiveFraction +
        (1 - effectiveFraction);
    spacers[reversed ? 2 : 0].style.width = `${leftOffset * 100}%`;
    spacers[reversed ? 0 : 2].style.width = `${(1 - rightOffset) * 100}%`;
    const {invertArrows} = this;
    invertArrows[reversed ? 1 : 0].style.display = '';
    invertArrows[reversed ? 0 : 1].style.display = 'none';
  }
}

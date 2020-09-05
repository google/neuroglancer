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

/**
 * Facility for drawing a scale bar to indicate pixel size in physical length
 * units.
 *
 * The physical length with which the scale bar is labeled will be of the form:
 *
 *   significand * 10^exponent
 *
 * Any exponent may be used, but the significand in the range [1, 10] will be
 * equal to one of a
 * discrete set of allowed significand values, in order to ensure that the scale
 * bar is easy to
 * understand.
 */

import {RenderViewport} from 'neuroglancer/display_context';
import {DisplayDimensionRenderInfo, RelativeDisplayScales} from 'neuroglancer/navigation_state';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyFloat, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {pickSiPrefix} from 'neuroglancer/util/si_units';
import {GL} from 'neuroglancer/webgl/context';
import {OffscreenCopyHelper} from 'neuroglancer/webgl/offscreen';
import {setTextureFromCanvas} from 'neuroglancer/webgl/texture';

/**
 * Default set of allowed significand values.  1 is implicitly part of the set.
 */
const DEFAULT_ALLOWED_SIGNIFICANDS = [
  1.5,
  2,
  3,
  5,
  7.5,
  10,
];

export interface LengthUnit {
  unit: string;
  lengthInNanometers: number;
}

export const ALLOWED_UNITS: LengthUnit[] = [
  {unit: 'km', lengthInNanometers: 1e12},
  {unit: 'm', lengthInNanometers: 1e9},
  {unit: 'mm', lengthInNanometers: 1e6},
  {unit: 'µm', lengthInNanometers: 1e3},
  {unit: 'nm', lengthInNanometers: 1},
  {unit: 'pm', lengthInNanometers: 1e-3},
];

export function pickLengthUnit(lengthInNanometers: number) {
  const numAllowedUnits = ALLOWED_UNITS.length;
  let unit = ALLOWED_UNITS[numAllowedUnits - 1];
  for (let i = 0; i < numAllowedUnits; ++i) {
    const allowedUnit = ALLOWED_UNITS[i];
    if (lengthInNanometers >= allowedUnit.lengthInNanometers) {
      unit = allowedUnit;
      break;
    }
  }
  return unit;
}

export function pickVolumeUnit(volumeInCubicNanometers: number) {
  const numAllowedUnits = ALLOWED_UNITS.length;
  let unit = ALLOWED_UNITS[numAllowedUnits - 1];
  for (let i = 0; i < numAllowedUnits; ++i) {
    const allowedUnit = ALLOWED_UNITS[i];
    if (volumeInCubicNanometers >= Math.pow(allowedUnit.lengthInNanometers, 3)) {
      unit = allowedUnit;
      break;
    }
  }
  return unit;
}

export class ScaleBarDimensions {
  /**
   * Allowed significand values.  1 is not included, but is always considered
   * part of the set.
   */
  allowedSignificands = DEFAULT_ALLOWED_SIGNIFICANDS;

  /**
   * The target length in pixels.  The closest
   */
  targetLengthInPixels: number = 0;

  /**
   * Pixel size in base physical units.
   */
  physicalSizePerPixel: number = 0;

  /**
   * Base physical unit, e.g. "m" (for meters) or "s" (for seconds).
   */
  physicalBaseUnit: string;

  // The following three fields are computed from the previous three fields.

  /**
   * Length that scale bar should be drawn, in pixels.
   */
  lengthInPixels: number;

  /**
   * Physical length with which to label the scale bar.
   */
  physicalLength: number;
  physicalUnit: string;

  prevPhysicalSizePerPixel: number = 0;
  prevTargetLengthInPixels: number = 0;
  prevPhysicalUnit: string = '\0';

  /**
   * Updates physicalLength, physicalUnit, and lengthInPixels to be the optimal values corresponding
   * to targetLengthInPixels and physicalSizePerPixel.
   *
   * @returns true if the scale bar has changed, false if it is unchanged.
   */
  update() {
    let {physicalSizePerPixel, targetLengthInPixels} = this;
    if (this.prevPhysicalSizePerPixel === physicalSizePerPixel &&
        this.prevTargetLengthInPixels === targetLengthInPixels &&
        this.prevPhysicalUnit === this.physicalUnit) {
      return false;
    }
    this.prevPhysicalSizePerPixel = physicalSizePerPixel;
    this.prevTargetLengthInPixels = targetLengthInPixels;
    this.prevPhysicalUnit = this.physicalUnit;
    const targetPhysicalSize = targetLengthInPixels * physicalSizePerPixel;
    const exponent = Math.floor(Math.log10(targetPhysicalSize));
    const tenToThePowerExponent = 10 ** exponent;
    const targetSignificand = targetPhysicalSize / tenToThePowerExponent;

    // Determine significand value in this.allowedSignificands that is closest
    // to targetSignificand.
    let bestSignificand = 1;
    for (let allowedSignificand of this.allowedSignificands) {
      if (Math.abs(allowedSignificand - targetSignificand) <
          Math.abs(bestSignificand - targetSignificand)) {
        bestSignificand = allowedSignificand;
      } else {
        // If distance did not decrease, then it can only increase from here.
        break;
      }
    }

    const physicalSize = bestSignificand * tenToThePowerExponent;
    const siPrefix = pickSiPrefix(physicalSize);
    this.lengthInPixels = Math.round(physicalSize / physicalSizePerPixel);
    this.physicalUnit = `${siPrefix.prefix}${this.physicalBaseUnit}`;
    this.physicalLength = bestSignificand * 10 ** (exponent - siPrefix.exponent);
    return true;
  }
}

function makeScaleBarTexture(
    dimensions: ScaleBarDimensions, gl: GL, texture: WebGLTexture|null, label: string,
    options: ScaleBarTextureOptions) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const textHeight = options.textHeightInPixels * options.scaleFactor;
  const font = `bold ${textHeight}px ${options.fontName}`;
  ctx.font = font;
  ctx.fillStyle = 'white';
  const text = `${label}${dimensions.physicalLength} ${dimensions.physicalUnit}`;
  const textMetrics = ctx.measureText(text);
  const innerWidth = Math.max(dimensions.lengthInPixels, textMetrics.width);
  const barHeight = options.barHeightInPixels * options.scaleFactor;
  const barTopMargin = options.barTopMarginInPixels * options.scaleFactor;
  const innerHeight = barHeight + barTopMargin + textHeight;
  const padding = options.paddingInPixels * options.scaleFactor;
  const totalHeight = innerHeight + 2 * padding;
  const totalWidth = innerWidth + 2 * padding;
  canvas.width = totalWidth;
  canvas.height = totalHeight;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(0, 0, totalWidth, totalHeight);
  ctx.fillStyle = 'white';
  ctx.fillText(text, totalWidth / 2, totalHeight - padding - barHeight - barTopMargin);
  ctx.fillRect(padding, totalHeight - padding - barHeight, dimensions.lengthInPixels, barHeight);
  setTextureFromCanvas(gl, texture, canvas);
  return {width: totalWidth, height: totalHeight};
}

export class ScaleBarTexture extends RefCounted {
  texture: WebGLTexture|null = null;
  width = 0;
  height = 0;
  label = '';
  factor = 1;
  private priorOptions: ScaleBarTextureOptions|undefined = undefined;
  private prevLabel: string = '';

  constructor(public gl: GL, public dimensions = new ScaleBarDimensions()) {
    super();
  }

  update(options: ScaleBarTextureOptions) {
    const {dimensions, label} = this;
    let {texture} = this;
    if (!dimensions.update() && texture !== null && options === this.priorOptions &&
        label == this.prevLabel) {
      return;
    }
    if (texture === null) {
      texture = this.texture = this.gl.createTexture();
    }
    const {width, height} = makeScaleBarTexture(dimensions, this.gl, texture, label, options);
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

export class MultipleScaleBarTextures extends RefCounted {
  private scaleBarCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  private scaleBars: ScaleBarTexture[] = [];

  constructor(public gl: GL) {
    super();
    for (let i = 0; i < 3; ++i) {
      this.scaleBars.push(this.registerDisposer(new ScaleBarTexture(gl)));
    }
  }

  draw(
      viewport: RenderViewport, displayDimensionRenderInfo: DisplayDimensionRenderInfo,
      relativeDisplayScales: RelativeDisplayScales, effectiveZoom: number,
      options: ScaleBarOptions) {
    const {scaleBars} = this;
    const {
      displayRank,
      displayDimensionIndices,
      canonicalVoxelFactors,
      globalDimensionNames,
      displayDimensionUnits,
      displayDimensionScales,
    } = displayDimensionRenderInfo;

    const {factors} = relativeDisplayScales;

    const targetLengthInPixels = Math.min(
        options.maxWidthFraction * viewport.logicalWidth,
        options.maxWidthInPixels * options.scaleFactor);

    let numScaleBars = 0;

    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const unit = displayDimensionUnits[i];
      const factor = factors[dim];
      let barIndex;
      let scaleBar: ScaleBarTexture;
      let scaleBarDimensions: ScaleBarDimensions;
      for (barIndex = 0; barIndex < numScaleBars; ++barIndex) {
        scaleBar = scaleBars[barIndex];
        scaleBarDimensions = scaleBar.dimensions;
        if (scaleBarDimensions.physicalBaseUnit === unit && scaleBar.factor === factor) {
          break;
        }
      }
      if (barIndex === numScaleBars) {
        ++numScaleBars;
        scaleBar = scaleBars[barIndex];
        scaleBar.label = '';
        scaleBarDimensions = scaleBar.dimensions;
        scaleBar.factor = factor;
        scaleBarDimensions.physicalBaseUnit = unit;
        scaleBarDimensions.targetLengthInPixels = targetLengthInPixels;
        scaleBarDimensions.physicalSizePerPixel =
            displayDimensionScales[i] * effectiveZoom / canonicalVoxelFactors[i];
      }
      scaleBar!.label += `${globalDimensionNames[dim]} `;
    }

    const {gl, scaleBarCopyHelper} = this;

    let bottomPixelOffset = options.bottomPixelOffset * options.scaleFactor;
    for (let barIndex = numScaleBars - 1; barIndex >= 0; --barIndex) {
      const scaleBar = scaleBars[barIndex];
      if (numScaleBars === 1) {
        scaleBar.label = '';
      } else {
        scaleBar.label += ': ';
      }
      scaleBar.update(options);
      gl.viewport(
          options.leftPixelOffset * options.scaleFactor -
              viewport.visibleLeftFraction * viewport.logicalWidth,
          bottomPixelOffset -
              (1 - (viewport.visibleTopFraction + viewport.visibleHeightFraction)) *
                  viewport.logicalHeight,
          scaleBar.width, scaleBar.height);
      scaleBarCopyHelper.draw(scaleBar.texture);
      bottomPixelOffset +=
          scaleBar.height + options.marginPixelsBetweenScaleBars * options.scaleFactor;
    }
  }
}

export interface ScaleBarTextureOptions {
  textHeightInPixels: number;
  barTopMarginInPixels: number;
  fontName: string;
  barHeightInPixels: number;
  paddingInPixels: number;
  scaleFactor: number;
}

export interface ScaleBarOptions extends ScaleBarTextureOptions {
  maxWidthInPixels: number;
  maxWidthFraction: number;
  leftPixelOffset: number;
  bottomPixelOffset: number;
  marginPixelsBetweenScaleBars: number;
}

export const defaultScaleBarTextureOptions: ScaleBarTextureOptions = {
  scaleFactor: 1,
  textHeightInPixels: 15,
  barHeightInPixels: 8,
  barTopMarginInPixels: 5,
  fontName: 'sans-serif',
  paddingInPixels: 2,
};

export const defaultScaleBarOptions: ScaleBarOptions = {
  ...defaultScaleBarTextureOptions,
  maxWidthInPixels: 100,
  maxWidthFraction: 0.25,
  leftPixelOffset: 10,
  bottomPixelOffset: 10,
  marginPixelsBetweenScaleBars: 5,
};

function parseScaleBarOptions(obj: any): ScaleBarOptions {
  const result = {
    ...defaultScaleBarOptions,
  };
  for (const k of <(Exclude<keyof ScaleBarOptions, 'fontName'>)[]>[
         'textHeightInPixels', 'barTopMarginInPixels', 'barHeightInPixels', 'paddingInPixels',
         'scaleFactor', 'maxWidthInPixels', 'maxWidthFraction', 'leftPixelOffset',
         'bottomPixelOffset'
       ]) {
    verifyObjectProperty(obj, k, x => {
      if (x !== undefined) {
        result[k] = verifyFloat(x);
      }
    });
  }
  verifyObjectProperty(obj, 'fontName', x => {
    if (x !== undefined) {
      result.fontName = verifyString(x);
    }
  });
  return result;
}

export class TrackableScaleBarOptions extends TrackableValue<ScaleBarOptions> {
  constructor() {
    super(defaultScaleBarOptions, parseScaleBarOptions);
  }
}

/**
 * @license
 * Copyright 2019 Google Inc.
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
 * @file Velocity estimation for prefetching using exponentially-weighted moving estimate of
 * univariate gaussian distribution of per-dimension velocities.
 *
 * Because changes to the global position are not continuous, we estimate the velocity itself using
 * an exponentially-weighted moving average over a relatively short time scale
 * `velocityHalfLifeMilliseconds`, and then estimate a mean and variance of these velocity estimates
 * using an expeonentially-weighted moving average over a longer time scale.
 */

const VELOCITY_HALF_LIFE_MS = 50;
const MODEL_HALF_LIFE_MS = 1000;

export class VelocityEstimator {
  private lastTime = Number.NEGATIVE_INFINITY;
  rank = 0;

  private numSamples = 0;

  // Previous position sampled.
  private prevPosition = new Float32Array();

  // Moving average of raw velocity over `velocityHalfLifeMilliseconds`.
  private velocity = new Float32Array();

  // Moving average of `velocity` estimate using `modelHalfLifeMilliseconds`.
  mean = new Float32Array();
  // Moving variance of `velocity` estimate using `modelHalfLifeMilliseconds`.
  variance = new Float32Array();

  constructor(
      public velocityHalfLifeMilliseconds: number = VELOCITY_HALF_LIFE_MS,
      public modelHalfLifeMilliseconds: number = MODEL_HALF_LIFE_MS) {}

  reset(rank: number) {
    this.lastTime = Number.NEGATIVE_INFINITY;
    this.rank = rank;
    this.numSamples = 0;
    this.velocity = new Float32Array(rank);
    this.prevPosition = new Float32Array(rank);
    this.mean = new Float32Array(rank);
    this.variance = new Float32Array(rank);
  }

  addSample(position: Float32Array, time = Date.now()) {
    const rank = position.length;
    if (rank !== this.rank) {
      this.reset(rank);
    }

    const numSamples = this.numSamples;
    ++this.numSamples;

    // Update `velocity` estimate.
    if (this.numSamples === 0) {
      this.prevPosition.set(position);
      this.lastTime = time;
      return;
    }

    const deltaT = time - this.lastTime;
    this.lastTime = time;
    const velocityAlpha = 1 - Math.pow(2, -(deltaT / this.velocityHalfLifeMilliseconds));
    const modelAlpha = 1 - Math.pow(2, -(deltaT / this.modelHalfLifeMilliseconds));
    const {velocity, prevPosition, mean, variance} = this;
    for (let i = 0; i < rank; ++i) {
      const curVelocitySample = (position[i] - prevPosition[i]) / Math.max(deltaT, 1);
      prevPosition[i] = position[i];
      const prevVelocity = velocity[i];
      const newVelocity = velocity[i] =
          prevVelocity + velocityAlpha * (curVelocitySample - prevVelocity);
      if (numSamples === 1) {
        mean[i] = newVelocity;
      } else {
        const meanPrev = mean[i];
        const varPrev = variance[i];
        const delta = newVelocity - meanPrev;
        mean[i] = meanPrev + modelAlpha * delta;
        variance[i] = (1 - modelAlpha) * (varPrev + modelAlpha * delta * delta);
      }
    }
  }
}

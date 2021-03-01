/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file Facility for triggering named actions in response to touch events.
 */

import throttle from 'lodash/throttle';
import {RefCounted} from 'neuroglancer/util/disposable';
import {ActionEvent, dispatchEvent, EventActionMap, EventActionMapInterface, registerActionListener} from 'neuroglancer/util/event_action_map';

export interface TouchTapInfo {
  event: TouchEvent;
  centerX: number;
  centerY: number;
}

export interface TouchTranslateInfo {
  event: TouchEvent;
  centerX: number;
  centerY: number;
  deltaX: number;
  deltaY: number;
}

export interface TouchPinchInfo {
  event: TouchEvent;
  centerX: number;
  centerY: number;
  distance: number;
  prevDistance: number;
}

export interface TouchRotateInfo {
  event: TouchEvent;
  centerX: number;
  centerY: number;
  angle: number;
  prevAngle: number;
}

export interface TouchHoldInfo {
  event: TouchEvent;
  centerX: number;
  centerY: number;
}

/**
 * Minimum number of pixels in x and y that a touch point must move to trigger a
 * translate/rotate/pinch action.  This helps filter out spurious tiny movements that are hard to
 * avoid, especially with one finger touches.
 **/
const moveThreshold = 10;

/**
 * Number of milliseconds that a set of touch points must be held without moving (per moveThreshold)
 * to trigger a touchhold action.
 **/
const holdThreshold = 1000;

/**
 * Maximum duration of a tap.
 */
const maxTapDuration = 400;

/**
 * Maximum number of milliseconds delay between two taps to trigger a multitap action.
 */
const multiTapMaxInterval = 500;

const rotateThreshold = Math.PI / 20;
const pinchThreshold = 20
const translateThreshold = 10;

function norm2(deltaX: number, deltaY: number) {
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function getTwoFingerDistanceAndAngle(touches: Iterable<Touch>) {
  let [t0,t1] = touches;
  if (t0.identifier > t1.identifier) {
    [t1, t0] = [t0, t1];
  }
  const offsetX = t0.clientX - t1.clientX;
  const offsetY = t0.clientY - t1.clientY;
  const distance = norm2(offsetX, offsetY);
  const angle = Math.atan2(offsetX, offsetY);
  return {distance, angle};
}

function getAngleDifference(x: number, y: number) {
  const TAU = Math.PI * 2;
  const d = Math.abs(x - y) % TAU;
  return Math.min(d, TAU - d);
}

export class TouchEventBinder<EventMap extends EventActionMapInterface> extends RefCounted {
  private dispatch(
      eventIdentifier: string, event: Event, detail: any, eventPhase: number = event.eventPhase) {
    dispatchEvent(eventIdentifier, event, eventPhase, detail, this.eventMap);
  }
  private prevTouches = new Map<number, Touch>();
  private prevEvent?: TouchEvent;
  private moved = false;

  /**
   * Initial angle for two-finger touch.  Once the difference between this ange the current angle
   * exceeds `rotateThreshold`, `touchrotate` events are dispatched.
   **/
  private prevAngle = 0;
  private rotated = false;

  /**
   * Initial distance for two-finger touch.  Once the difference between this ange the current
   * distance exceeds `pinchThreshold`, `touchpinich` events are dispatched.
   **/
  private prevDistance = 0;
  private pinched = false;

  private prevCenterX = 0;
  private prevCenterY = 0;
  private translated = false;
  
  private startHold = this.registerCancellable(
      throttle((event: TouchEvent, eventPhase: number, centerX: number, centerY: number) => {
        const info = {event, centerX, centerY};
        this.dispatch(`touchhold${event.targetTouches.length}`, event, info, eventPhase);
      }, holdThreshold, {leading: false, trailing: true}));
  private numPriorTaps = 0;
  private priorTapNumTouches = 0;
  private tapStartTime = 0;
  private tapEndTime = 0;
  private curTapNumTouches = 0;

  private handleTouchEvent(event: TouchEvent) {
    if (event.target === this.target) {
      event.preventDefault();
    } else {
      return;
    }
    const newTouches = new Map<number, Touch>();
    const {prevTouches, prevEvent} = this;
    
    // Compute average movement.
    let centerX = 0, centerY = 0;
    
    for (const touch of event.targetTouches) {
      newTouches.set(touch.identifier, touch);
      centerX += touch.clientX;
      centerY += touch.clientY;
    }
    centerX /= newTouches.size;
    centerY /= newTouches.size;
    // Remove touches that are no longer matched.
    for (const [key, touch] of prevTouches.entries()) {
      const newTouch = newTouches.get(key);
      if (newTouch === undefined) {
        prevTouches.delete(key);
      } else {
        const deltaX = newTouch.clientX - touch.clientX;
        const deltaY = newTouch.clientY - touch.clientY;
        if (Math.abs(deltaX) >= moveThreshold || Math.abs(deltaY) >= moveThreshold) {
          this.moved = true;
        }
      }
    }

    if (prevEvent === undefined || prevEvent.targetTouches.length !== newTouches.size ||
        newTouches.size == 0) {
      this.moved = false;

      if (event.type === 'touchstart') {
        this.startHold(event, event.eventPhase, centerX, centerY);
        if (prevEvent === undefined || prevEvent.targetTouches.length === 0) {
          this.tapStartTime = Date.now();
          this.curTapNumTouches = 0;
        }
        this.curTapNumTouches = Math.max(this.curTapNumTouches, event.targetTouches.length);
      } else {
        if (event.type == 'touchend') {
          const now = Date.now();
          if (event.targetTouches.length === 0 && now - this.tapStartTime < maxTapDuration) {
            if (this.curTapNumTouches !== this.priorTapNumTouches ||
                now - this.tapEndTime >= multiTapMaxInterval) {
              this.numPriorTaps = 0;
            }
            ++this.numPriorTaps;
            this.tapEndTime = now;
            this.priorTapNumTouches = this.curTapNumTouches;
            const info: TouchTapInfo = {event, centerX, centerY};
            this.dispatch(`touchtap${this.curTapNumTouches}x${this.numPriorTaps}`, event, info);
          }
        }
        this.startHold.cancel();
      }
      // Number of touches has changed.  Don't dispatch any events.
      // TODO: handle tap events
      this.prevTouches = newTouches;
      this.prevEvent = event;

      this.prevCenterX = centerX;
      this.prevCenterY = centerY;
      this.translated = false;

      if (newTouches.size === 2) {
        const {distance, angle} = getTwoFingerDistanceAndAngle(newTouches.values());
        this.prevDistance = distance;
        this.prevAngle = angle;
        this.rotated = false;
        this.pinched = false;
      }
      return;
    }

    if (!this.moved) {
      return;
    }
    this.tapStartTime = 0;
    this.startHold.cancel();
    this.prevTouches = newTouches;
    this.prevEvent = event;

    let {prevCenterX, prevCenterY, translated} = this;
    const deltaX = centerX - prevCenterX;
    const deltaY = centerY - prevCenterY;
    if (translated === false && norm2(deltaX, deltaY) >= translateThreshold) {
      translated = this.translated = true;
    }
    if (translated === true && (deltaX !== 0 || deltaY !== 0)) {
      this.prevCenterX = centerX;
      this.prevCenterY = centerY;
      const info: TouchTranslateInfo = {event, deltaX, deltaY, centerX, centerY};
      this.dispatch(`touchtranslate${newTouches.size}`, event, info);
    }

    if (newTouches.size === 2) {
      const {distance, angle} = getTwoFingerDistanceAndAngle(newTouches.values());
      let {pinched, rotated, prevDistance, prevAngle} = this;
      if (pinched === false && Math.abs(distance - prevDistance) >= pinchThreshold) {
        this.pinched = pinched = true;
      }

      const angleDiff = getAngleDifference(angle, prevAngle);

      if (rotated === false && angleDiff >= rotateThreshold) {
        this.rotated = rotated = true;
      }

      if (pinched === true && distance != prevDistance) {
        this.prevDistance = distance;
        const info: TouchPinchInfo = {event, distance, prevDistance, centerX, centerY};
        this.dispatch(`touchpinch`, event, info);
      }

      if (rotated === true && angle !== prevAngle) {
        this.prevAngle = angle;
        this.dispatch(`touchrotate`, event, {event, centerX, centerY, angle, prevAngle});
      }
    }
  }
  constructor(public target: HTMLElement, public eventMap: EventMap) {
    super();
    this.registerEventListener(target, 'touchstart', (event: TouchEvent) => {
      this.handleTouchEvent(event);
    });
    this.registerEventListener(target, 'touchmove', (event: TouchEvent) => {
      this.handleTouchEvent(event);
    });
    this.registerEventListener(target, 'touchend', (event: TouchEvent) => {
      this.handleTouchEvent(event);
    });
  }
}

export {EventActionMap, registerActionListener};
export type {EventActionMapInterface, ActionEvent};

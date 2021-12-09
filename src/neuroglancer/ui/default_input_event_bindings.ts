/**
 * @license
 * Copyright 2017 Google Inc.
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

import {EventActionMap} from 'neuroglancer/util/event_action_map';
import {InputEventBindings} from 'neuroglancer/viewer';

let defaultGlobalBindings: EventActionMap|undefined;

export function getDefaultGlobalBindings() {
  if (defaultGlobalBindings === undefined) {
    const map = new EventActionMap();
    map.set('keyl', 'recolor');
    map.set('keyx', 'clear-segments');
    map.set('keys', 'toggle-show-slices');
    map.set('keyb', 'toggle-scale-bar');
    map.set('keyv', 'toggle-default-annotations');
    map.set('keya', 'toggle-axis-lines');
    map.set('keyo', 'toggle-orthographic-projection');

    for (let i = 1; i <= 9; ++i) {
      map.set('digit' + i, 'toggle-layer-' + i);
      map.set('control+digit' + i, 'select-layer-' + i);
      map.set('alt+digit' + i, 'toggle-pick-layer-' + i);
    }

    for (let i = 0; i < 26; ++i) {
      const lowercase = String.fromCharCode(97 + i);
      const uppercase = String.fromCharCode(65 + i);
      map.set(`alt?+control?+shift+key${lowercase}`, `tool-${uppercase}`);
    }

    map.set('keyn', 'add-layer');
    map.set('keyh', 'help');

    map.set('space', 'toggle-layout');
    map.set('shift+space', 'toggle-layout-alternative');
    map.set('backslash', 'toggle-show-statistics');
    defaultGlobalBindings = map;
  }
  return defaultGlobalBindings;
}

let defaultSelectBindings: EventActionMap|undefined;
export function getDefaultSelectBindings() {
  if (defaultSelectBindings === undefined) {
    defaultSelectBindings = EventActionMap.fromObject({'control+mousedown2': 'select-position'});
  }
  return defaultSelectBindings;
}

let defaultAnnotationListBindings: EventActionMap|undefined;
export function getDefaultAnnotationListBindings() {
  if (defaultAnnotationListBindings === undefined) {
    defaultAnnotationListBindings = EventActionMap.fromObject(
        {
          'click0': 'pin-annotation',
          'mousedown2': 'move-to-annotation',
        },
        {parents: [[getDefaultSelectBindings(), 0]]});
  }
  return defaultAnnotationListBindings;
}

let defaultRenderedDataPanelBindings: EventActionMap|undefined;
export function getDefaultRenderedDataPanelBindings() {
  if (defaultRenderedDataPanelBindings === undefined) {
    defaultRenderedDataPanelBindings = EventActionMap.fromObject(
        {
          'arrowleft': 'x-',
          'arrowright': 'x+',
          'arrowup': 'y-',
          'arrowdown': 'y+',
          'comma': 'z-',
          'period': 'z+',
          'bracketleft': 't-',
          'bracketright': 't+',
          'keyz': 'snap',
          'control+equal': 'zoom-in',
          'alt+equal': 'depth-range-decrease',
          'control+shift+equal': 'zoom-in',
          'alt+shift+equal': 'depth-range-decrease',
          'control+minus': 'zoom-out',
          'alt+minus': 'depth-range-increase',
          'keyr': 'rotate-relative-z-',
          'keye': 'rotate-relative-z+',
          'shift+arrowdown': 'rotate-relative-x-',
          'shift+arrowup': 'rotate-relative-x+',
          'shift+arrowleft': 'rotate-relative-y-',
          'shift+arrowright': 'rotate-relative-y+',
          'control+wheel': {action: 'zoom-via-wheel', preventDefault: true},
          'alt+wheel': {action: 'adjust-depth-range-via-wheel', preventDefault: true},
          'at:wheel': {action: 'z+1-via-wheel', preventDefault: true},
          'at:shift+wheel': {action: 'z+10-via-wheel', preventDefault: true},
          'at:dblclick0': 'select',
          'at:control+mousedown0': 'annotate',
          'at:mousedown2': 'move-to-mouse-position',
          'at:alt+mousedown0': 'move-annotation',
          'at:control+alt+mousedown2': 'delete-annotation',
          'at:touchpinch': 'zoom-via-touchpinch',
          'at:touchrotate': 'rotate-in-plane-via-touchrotate',
          'at:touchtranslate2': 'translate-in-plane-via-touchtranslate',
          'at:touchhold1': 'move-to-mouse-position',
          'at:touchtap1x2': 'select',
          'at:touchtap2x3': 'snap',
        },
        {
          label: 'All Data Panels',
          parents: [[getDefaultSelectBindings(), 0]],
        });
  }
  return defaultRenderedDataPanelBindings;
}

let defaultPerspectivePanelBindings: EventActionMap|undefined;
export function getDefaultPerspectivePanelBindings() {
  if (defaultPerspectivePanelBindings === undefined) {
    defaultPerspectivePanelBindings = EventActionMap.fromObject(
        {
          'at:mousedown0': {action: 'rotate-via-mouse-drag', stopPropagation: true},
          'at:shift+mousedown0': {action: 'translate-via-mouse-drag', stopPropagation: true},
          'at:touchtranslate1': 'rotate-out-of-plane-via-touchtranslate',
        },
        {parents: [[getDefaultRenderedDataPanelBindings(), Number.NEGATIVE_INFINITY]]});
  }
  return defaultPerspectivePanelBindings;
}

let defaultSliceViewPanelBindings: EventActionMap|undefined;
export function getDefaultSliceViewPanelBindings() {
  if (defaultSliceViewPanelBindings === undefined) {
    defaultSliceViewPanelBindings = EventActionMap.fromObject(
        {
          'at:mousedown0': {action: 'translate-via-mouse-drag', stopPropagation: true},
          'at:shift+mousedown0': {action: 'rotate-via-mouse-drag', stopPropagation: true},
          'at:touchtranslate1': 'translate-z-via-touchtranslate',
        },
        {parents: [[getDefaultRenderedDataPanelBindings(), Number.NEGATIVE_INFINITY]]});
  }
  return defaultSliceViewPanelBindings;
}

export function setDefaultInputEventBindings(inputEventBindings: InputEventBindings) {
  inputEventBindings.global.addParent(getDefaultGlobalBindings(), Number.NEGATIVE_INFINITY);
  inputEventBindings.sliceView.addParent(
      getDefaultSliceViewPanelBindings(), Number.NEGATIVE_INFINITY);
  inputEventBindings.perspectiveView.addParent(
      getDefaultPerspectivePanelBindings(), Number.NEGATIVE_INFINITY);
}

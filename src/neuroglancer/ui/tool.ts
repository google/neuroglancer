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
 * @file Support for defining user-selectable annotation tools.
 */

import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';

export abstract class Tool extends RefCounted {
  setActive(_value: boolean): void {}
  abstract trigger(mouseState: MouseSelectionState): void;
  abstract toJSON(): any;
  deactivate(): void {}
  description: string;
}

export function restoreTool(layer: UserLayer, obj: any) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'string') {
    obj = {'type': obj};
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', verifyString);
  const getter = tools.get(type);
  if (getter === undefined) {
    throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
  }
  return getter(layer, obj);
}

export type ToolGetter = (layer: UserLayer, options: any) => Owned<Tool>;

const tools = new Map<string, ToolGetter>();

export function registerTool(type: string, getter: ToolGetter) {
  tools.set(type, getter);
}

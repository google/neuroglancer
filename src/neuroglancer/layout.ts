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

export interface Handler { (element: HTMLElement): void; }

export function withFlex(value: any, handler: Handler) {
  return (element: HTMLElement) => {
    element.style.flex = value;
    handler(element);
  };
}
export function withStyle(style: {}, handler: Handler) {
  return (element: HTMLElement) => {
    Object.assign(element.style, style);
    handler(element);
  };
}

export function withAttributes(attributes: {}, handler: Handler) {
  return (element: HTMLElement) => {
    Object.assign(element, attributes);
    handler(element);
  };
}

export function box(flexDirection: string, spec: Handler[]) {
  return (container: HTMLElement) => {
    container.style.display = 'flex';
    container.style.flexDirection = flexDirection;
    for (let handler of spec) {
      let element = container.ownerDocument!.createElement('div');
      container.appendChild(element);
      handler(element);
    }
  };
}

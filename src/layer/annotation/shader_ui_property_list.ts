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

export interface ShaderPropertyListMetadata {
  type: string;
  identifier: string;
  description?: string;
}

export function buildShaderPropertyList(
  properties: readonly Readonly<ShaderPropertyListMetadata>[],
  parent: HTMLElement,
) {
  const propertyList = document.createElement("div");
  parent.appendChild(propertyList);
  propertyList.classList.add("neuroglancer-annotation-shader-property-list");
  for (const property of properties) {
    const div = document.createElement("div");
    div.classList.add("neuroglancer-annotation-shader-property");
    const typeElement = document.createElement("span");
    typeElement.classList.add("neuroglancer-annotation-shader-property-type");
    typeElement.textContent = property.type;
    const nameElement = document.createElement("span");
    nameElement.classList.add(
      "neuroglancer-annotation-shader-property-identifier",
    );
    nameElement.textContent = `prop_${property.identifier}`;
    div.appendChild(typeElement);
    div.appendChild(nameElement);
    const { description } = property;
    if (description !== undefined) {
      div.title = description;
    }
    propertyList.appendChild(div);
  }
}

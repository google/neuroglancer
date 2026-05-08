/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { TypedArray } from "#src/util/array.js";
import type { GL } from "#src/webgl/context.js";
import {
  setOneDimensionalTextureData,
  type TextureFormat,
} from "#src/webgl/texture_access.js";

function getOneDimensionalTextureRowCapacity(gl: GL, numElements: number) {
  const minX = Math.ceil(numElements / gl.maxTextureSize);
  return 1 << Math.ceil(Math.log2(Math.max(minX, 1)));
}

/**
 * Uploads vertex attribute data to GPU as 1D textures.
 *
 * This function takes contiguous packed vertex attribute data and creates separate
 * GPU textures for each attribute type (e.g., positions, segment IDs, etc.).
 *
 * @param gl - WebGL rendering context
 * @param vertexAttributes - Packed byte array containing all vertex attributes
 * @param vertexAttributeOffsets - Byte offsets marking the start of each attribute in the packed array
 * @param attributeTextureFormats - Texture format specifications for each attribute
 * @returns Array of WebGL textures, one per attribute
 */
/**
 * Uploads separate per-attribute byte views to GPU as 1D textures.
 * Avoids the intermediate packed buffer required by uploadVertexAttributesToGPU.
 */
export function uploadAttributeBuffersToGPU(
  gl: GL,
  attributeBuffers: readonly Uint8Array[],
  attributeTextureFormats: TextureFormat[],
): (WebGLTexture | null)[] {
  const textures: (WebGLTexture | null)[] = [];
  for (let i = 0; i < attributeBuffers.length; i++) {
    const texture = gl.createTexture();
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    setOneDimensionalTextureData(gl, attributeTextureFormats[i], attributeBuffers[i]);
    textures[i] = texture;
  }
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  return textures;
}

export function uploadVertexAttributesToGPU(
  gl: GL,
  vertexAttributes: Uint8Array,
  vertexAttributeOffsets: Uint32Array,
  attributeTextureFormats: TextureFormat[],
): (WebGLTexture | null)[] {
  const vertexAttributeTextures: (WebGLTexture | null)[] = [];
  const numAttributes = vertexAttributeOffsets.length;

  for (let i = 0; i < numAttributes; ++i) {
    const texture = gl.createTexture();
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    setOneDimensionalTextureData(
      gl,
      attributeTextureFormats[i],
      vertexAttributes.subarray(
        vertexAttributeOffsets[i],
        i + 1 !== numAttributes
          ? vertexAttributeOffsets[i + 1]
          : vertexAttributes.length,
      ),
    );
    vertexAttributeTextures[i] = texture;
  }
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);

  return vertexAttributeTextures;
}

export function updateOneDimensionalTextureElement(
  gl: GL,
  texture: WebGLTexture,
  format: TextureFormat,
  numElements: number,
  elementIndex: number,
  data: TypedArray,
) {
  if (elementIndex < 0 || elementIndex >= numElements) {
    return;
  }
  const { arrayConstructor, texelsPerElement, textureFormat, texelType } =
    format;
  if (data.constructor !== arrayConstructor) {
    data = new arrayConstructor(
      data.buffer,
      data.byteOffset,
      data.byteLength / arrayConstructor.BYTES_PER_ELEMENT,
    );
  }
  const elementsPerRow = getOneDimensionalTextureRowCapacity(gl, numElements);
  const x = (elementIndex % elementsPerRow) * texelsPerElement;
  const y = Math.floor(elementIndex / elementsPerRow);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(
    WebGL2RenderingContext.TEXTURE_2D,
    0,
    x,
    y,
    texelsPerElement,
    1,
    textureFormat,
    texelType,
    data,
  );
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
}

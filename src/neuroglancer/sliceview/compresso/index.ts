/**
 * @license
 * Copyright 2021 William Silvermsith
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

// @ts-ignore
import createCompressoModule from './compresso';

const compressoModulePromise : any = createCompressoModule();

// not a full implementation of read header, just the parts we need
function readHeader(buffer: Uint8Array) : Map<string, number> {
  // check for header "cpso"
  const magic = (
       buffer[0] === 'c'.charCodeAt(0) && buffer[1] === 'p'.charCodeAt(0)
    && buffer[2] === 's'.charCodeAt(0) && buffer[3] === 'o'.charCodeAt(0)
  );
  if (!magic) {
    throw new Error("compresso: didn't match magic numbers")
  }
  const format = buffer[4];
  if (format !== 0) {
    throw new Error("compresso: didn't match format version")
  }

  const bufview = new DataView(buffer.buffer, 0);

  const dataWidth = buffer[5];
  const sx = bufview.getUint16(6, /*littleEndian=*/true);
  const sy = bufview.getUint16(8, /*littleEndian=*/true);
  const sz = bufview.getUint16(10, /*littleEndian=*/true);

  let map = new Map<string,number>();
  map.set("sx", sx);
  map.set("sy", sy);
  map.set("sz", sz);
  map.set("dataWidth", dataWidth);

  return map;
}

export function decompressCompresso(buffer: Uint8Array) 
  : Promise<Uint8Array> {
  
  // @ts-ignore
  return compressoModulePromise.then((m:any) => {
    const header : Map<string,number> = readHeader(buffer);
    const sx : number = header.get("sx")!;
    const sy : number = header.get("sy")!;
    const sz : number = header.get("sz")!;
    const dataWidth : number = header.get("dataWidth")!;

    const voxels = sx * sy * sz;
    const nbytes = voxels * dataWidth;

    if (nbytes < 0) {
      throw new Error(`Failed to decode compresso image. image size: ${nbytes}`);
    }
    
    const bufPtr = m._malloc(buffer.byteLength);
    m.HEAPU8.set(buffer, bufPtr);
    const imagePtr = m._malloc(nbytes);

    const code = m._compresso_decompress(
      bufPtr, buffer.byteLength, imagePtr
    );

    try {
      if (code !== 0) {
        throw new Error(`Failed to decode compresso image. decoder code: ${code}`);
      }

      const image = new Uint8Array(
        m.HEAPU8.buffer, imagePtr, voxels * dataWidth
      );
      // copy the array so it can be memory managed by JS
      // and we can free the emscripten buffer
      return image.slice(0);
    }
    finally {
      m._free(bufPtr);
      m._free(imagePtr);      
    }    
  });
}

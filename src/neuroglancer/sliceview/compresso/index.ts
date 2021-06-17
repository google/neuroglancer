/**
 * @license
 * Copyright William Silvermsith
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

import {TypedArray} from 'neuroglancer/util/array';

// @ts-ignore
import createCompressoModule from './compresso.js';

const compressoModulePromise : any = createCompressoModule();

// not a full implementation of read header, just the parts we need
function read_header(buffer: Uint8Array) : Map<string, number> {
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

  let u16 = (lower : number, upper: number) => { return (lower|0) + (upper << 8) };

  const data_width = buffer[5];
  const sx = u16(buffer[6], buffer[7]);
  const sy = u16(buffer[8], buffer[9]);
  const sz = u16(buffer[10], buffer[11]);

  let map = new Map<string,number>();
  map.set("sx", sx);
  map.set("sy", sy);
  map.set("sz", sz);
  map.set("data_width", data_width);

  return map;
}

function read_image(
  m:any, image_ptr:number,  
  sx:number, sy:number, sz:number, data_width:number
) : TypedArray {

  const voxels = sx * sy * sz;
  let image;

  let memory = m.HEAPU8.buffer;

  if (data_width === 1) {
    image = new Uint8Array(memory, image_ptr, voxels);
  }
  else if (data_width === 2) {
    image = new Uint16Array(memory, image_ptr, voxels);
  }
  else if (data_width === 4) {
    image = new Uint32Array(memory, image_ptr, voxels);
  }
  else if (data_width === 8) {
    image = new Uint32Array(memory, image_ptr, voxels * 2);
  }
  else {
    throw new Error(`data_width must be 1, 2, 4, or 8. Got: ${data_width}`);
  }

  // copy the array so it can be memory managed by JS
  // and we can free the emscripten buffer
  return image.slice(0); 
}

export function decompress_compresso(buffer: Uint8Array) 
  : Promise<TypedArray> {
  
  // @ts-ignore
  return compressoModulePromise.then((m:any) => {
    const header : Map<string,number> = read_header(buffer);
    const sx : number = header.get("sx")!;
    const sy : number = header.get("sy")!;
    const sz : number = header.get("sz")!;

    const voxels = sx * sy * sz;
    const nbytes = voxels * header.get("data_width")!;

    if (nbytes < 0) {
      throw new Error(`Failed to decode compresso image. image size: ${nbytes}`);
    }
    
    const buf_ptr = m._malloc(buffer.byteLength);
    m.HEAPU8.set(buffer, buf_ptr);
    const image_ptr = m._malloc(nbytes);

    const code = m._compresso_decompress(
      buf_ptr, buffer.byteLength, image_ptr
    );

    let image : TypedArray|null;

    if (code === 0) {
      image = read_image(
        m, image_ptr, 
        header.get("sx")!, header.get("sy")!, header.get("sz")!,
        header.get("data_width")!
      );
    }
    
    m._free(buf_ptr);
    m._free(image_ptr);

    if (code === 0) {
      return image!;
    }
    throw new Error(`Failed to decode compresso image. decoder code: ${code}`);
  });
}

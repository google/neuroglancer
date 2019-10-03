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

import {RawPartitionedMeshData} from 'neuroglancer/mesh/backend';
import dracoWasmUrl from 'url-loader!./neuroglancer_draco.wasm';

declare const WebAssembly: any;

const memory = new WebAssembly.Memory({initial: 1});
let heap8: Uint8Array;
function updateHeapViews() {
  heap8 = new Uint8Array(memory.buffer);
}
updateHeapViews();
var heap32 = new Uint32Array(memory.buffer);
var DYNAMIC_BASE = 38592, DYNAMICTOP_PTR = 5568;
heap32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
function abort() {
  throw 'abort';
}
function alignUp(x: number, multiple: number) {
  if (x % multiple > 0) {
    x += multiple - x % multiple
  }
  return x
}
function emscripten_realloc_buffer(size: number) {
  var PAGE_MULTIPLE = 65536;
  size = alignUp(size, PAGE_MULTIPLE);
  var oldSize = heap8.byteLength;
  try {
    var result = memory.grow((size - oldSize) / 65536);
    if (result !== (-1 | 0)) {
      return true;
    } else {
      return false;
    }
  } catch (e) {
    return false;
  }
}

let decodeResult: RawPartitionedMeshData|Error|undefined = undefined;
let numPartitions = 0;

const imports = {
  env: {
    memory: memory,
    table: new WebAssembly.Table({'initial': 368, 'maximum': 368, 'element': 'anyfunc'}),
    __memory_base: 1024,
    __table_base: 0,
    _neuroglancer_draco_receive_decoded_mesh: function(
        numFaces: number, numVertices: number, indicesPointer: number,
        vertexPositionsPointer: number, subchunkOffsetsPointer: number) {
      const numIndices = numFaces * 3;
      const indices = new Uint32Array(memory.buffer, indicesPointer, numIndices).slice();
      const vertexPositions =
          new Uint32Array(memory.buffer, vertexPositionsPointer, 3 * numVertices).slice();
      const subChunkOffsets =
          new Uint32Array(memory.buffer, subchunkOffsetsPointer, numPartitions + 1).slice();
      const mesh: RawPartitionedMeshData = {
        indices,
        vertexPositions,
        subChunkOffsets,
      };
      decodeResult = mesh;
    },
    _emscripten_memcpy_big: function(d: number, s: number, n: number) {
      heap8.set(heap8.subarray(s, s + n), d);
    },
    _emscripten_get_heap_size: function() {
      return heap8.length;
    },
    DYNAMICTOP_PTR: DYNAMICTOP_PTR,
    _abort: abort,
    abort: abort,
    abortOnCannotGrowMemory: abort,
    ___cxa_pure_virtual: abort,
    _llvm_trap: abort,
    ___setErrNo: abort,
    _emscripten_resize_heap: function(requestedSize: number) {
      var oldSize = heap8.length;
      var PAGE_MULTIPLE = 65536;
      var LIMIT = 2147483648 - PAGE_MULTIPLE;
      if (requestedSize > LIMIT) {
        return false
      }
      var MIN_TOTAL_MEMORY = 16777216;
      var newSize = Math.max(oldSize, MIN_TOTAL_MEMORY);
      while (newSize < requestedSize) {
        if (newSize <= 536870912) {
          newSize = alignUp(2 * newSize, PAGE_MULTIPLE)
        } else {
          newSize = Math.min(alignUp((3 * newSize + 2147483648) / 4, PAGE_MULTIPLE), LIMIT)
        }
      }
      var replacement = emscripten_realloc_buffer(newSize);
      if (!replacement) {
        return false
      }
      updateHeapViews();
      return true
    },
  },
};

const dracoModulePromise = fetch(dracoWasmUrl)
                               .then(response => response.arrayBuffer())
                               .then(wasmCode => WebAssembly.instantiate(wasmCode, imports));

export function decodeDracoPartitioned(
    buffer: Uint8Array, vertexQuantizationBits: number,
    partition: boolean): Promise<RawPartitionedMeshData> {
  return dracoModulePromise.then(m => {
    const offset = m.instance.exports._malloc(buffer.byteLength);
    heap8.set(buffer, offset);
    numPartitions = partition ? 8 : 1;
    const code = m.instance.exports._neuroglancer_draco_decode(
        offset, buffer.byteLength, partition, vertexQuantizationBits);
    if (code === 0) {
      const r = decodeResult;
      decodeResult = undefined;
      if (r instanceof Error) throw r;
      return r!;
    }
    throw new Error(`Failed to decode draco mesh: ${code}`);
  });
}

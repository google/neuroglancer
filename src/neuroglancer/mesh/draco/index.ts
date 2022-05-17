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

import {RawPartitionedMeshData, RawMeshData} from 'neuroglancer/mesh/backend';

import dracoWasmUrl from './neuroglancer_draco.wasm';

let decodeResult: RawPartitionedMeshData|Error|undefined = undefined;
let numPartitions = 0;

let wasmModule: WebAssembly.WebAssemblyInstantiatedSource|undefined;

const libraryEnv = {
  emscripten_notify_memory_growth: (memoryIndex: number) => {
    memoryIndex;
  },
  neuroglancer_draco_receive_decoded_mesh: function(
      numFaces: number, numVertices: number, indicesPointer: number, vertexPositionsPointer: number,
      subchunkOffsetsPointer: number) {
    const numIndices = numFaces * 3;
    const memory = wasmModule!.instance.exports.memory as WebAssembly.Memory;
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
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};
const dracoModulePromise = (async () => {
  const response = await fetch(dracoWasmUrl);
  const wasmCode = await response.arrayBuffer();
  const m = wasmModule = await WebAssembly.instantiate(wasmCode, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (m.instance.exports._initialize as Function)();
  return m;
})();

export async function decodeDracoPartitioned(
    buffer: Uint8Array, vertexQuantizationBits: number,
    partition: boolean): Promise<RawPartitionedMeshData> {
  const m = await dracoModulePromise;
  const offset = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, offset);
  numPartitions = partition ? 8 : 1;
  const code = (m.instance.exports.neuroglancer_draco_decode as Function)(
      offset, buffer.byteLength, partition, vertexQuantizationBits, true);
  if (code === 0) {
    const r = decodeResult;
    decodeResult = undefined;
    if (r instanceof Error) throw r;
    return r!;
  }
  throw new Error(`Failed to decode draco mesh: ${code}`);
}

export async function decodeDraco(
    buffer: Uint8Array): Promise<RawMeshData> {
  const m = await dracoModulePromise;
  const offset = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, offset);
  const code = (m.instance.exports.neuroglancer_draco_decode as Function)(
      offset, buffer.byteLength, false, 0, false);
  if (code === 0) {
    const r = decodeResult;
    decodeResult = undefined;
    if (r instanceof Error) throw r;
    r!.vertexPositions = new Float32Array(r!.vertexPositions.buffer)
    return r!;
  }
  throw new Error(`Failed to decode draco mesh: ${code}`);
}

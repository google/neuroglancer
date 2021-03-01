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

import {computeTriangleStrips, getBaseIndex, getEdgeIndex, getNextEdge, vertexAIndex, vertexBIndex, vertexCIndex} from 'neuroglancer/mesh/triangle_strips';

describe('triangle_strips', () => {
  describe('getBaseIndex', () => {
    it('works for simple examples', () => {
      expect([7 * 4 + 0, 7 * 4 + 1, 7 * 4 + 2].map(getBaseIndex)).toEqual([7 * 3, 7 * 3, 7 * 3]);
    });
  });
  describe('getEdgeIndex', () => {
    it('works for simple examples', () => {
      expect([7 * 4 + 0, 7 * 4 + 1, 7 * 4 + 2].map(getEdgeIndex)).toEqual([0, 1, 2]);
    });
  });
  describe('vertexAIndex', () => {
    it('works', () => {
      expect([0, 1, 2].map(vertexAIndex)).toEqual([0, 0, 1]);
    });
  });
  describe('vertexBIndex', () => {
    it('works', () => {
      expect([0, 1, 2].map(vertexBIndex)).toEqual([1, 2, 2]);
    });
  });
  describe('vertexCIndex', () => {
    it('works', () => {
      expect([0, 1, 2].map(vertexCIndex)).toEqual([2, 1, 0]);
    });
  });
  describe('getNextEdge', () => {
    it('works', () => {
      expect([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(
                 ([edgeIndex, flipped]) => getNextEdge(edgeIndex + flipped * 4)))
          .toEqual([2 + 0 * 4, 2 + 1 * 4, 1 + 1 * 4, 1 + 0 * 4, 0 + 0 * 4, 0 + 1 * 4]);
    });
  });
});


function getTrianglesFromIndices(indices: Uint32Array|Uint16Array) {
  const x: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    let a = indices[i], b = indices[i + 1], c = indices[i + 2];
    let t: number;
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    x.push(`${a},${b},${c}`);
  }
  x.sort();
  return x;
}

function getTrianglesFromStrips(indices: Uint32Array|Uint16Array) {
  const x: string[] = [];
  const invalidVertex = (indices.BYTES_PER_ELEMENT === 2) ? 0xFFFF : 0xFFFFFFFF;
  for (let i = 0; i + 2 < indices.length; ++i) {
    let a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (c === invalidVertex) {
      i += 2;
      continue;
    }
    let t: number;
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    x.push(`${a},${b},${c}`);
  }
  x.sort();
  return x;
}

function getRandomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min)) + min;
}

function makeRandomIndices(numTriangles: number, numVertices: number) {
  const indices = new Uint32Array(numTriangles * 3);
  for (let i = 0; i < numTriangles * 3; i += 3) {
    while (true) {
      const a = getRandomInt(0, numVertices), b = getRandomInt(0, numVertices),
            c = getRandomInt(0, numVertices);
      if (a === b || a === c || b === c) continue;
      indices[i] = a;
      indices[i + 1] = b;
      indices[i + 2] = c;
      break;
    }
  }
  return indices;
}

describe('triangle_strips', () => {
  it('works for simple example', () => {
    const indices = Uint32Array.from([
      0, 1, 2,  //
      3, 2, 1,  //
      5, 3, 4,  //
      4, 2, 3
    ]);
    const output = computeTriangleStrips(indices);
    expect(Array.from(output)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('works for two-strip example', () => {
    const indices = Uint32Array.from([
      0, 1, 2,  //
      3, 2, 1,  //
      6, 7, 8,  //
      7, 8, 9,  //
      6, 7, 9,  //
      5, 3, 4,  //
      4, 2, 3
    ]);
    const output = computeTriangleStrips(indices);
    expect(Array.from(output)).toEqual([0, 1, 2, 3, 4, 5, 0xFFFF, 8, 6, 7, 9, 8]);
  });

  it('works for two-strip example with isolated strip', () => {
    const indices = Uint32Array.from([
      0, 1, 2,  //
      3, 2, 1,  //
      6, 7, 8,  //
      6, 7, 8,  //
      7, 8, 9,  //
      6, 7, 9,  //
      5, 3, 4,  //
      4, 2, 3
    ]);
    const output = computeTriangleStrips(indices);
    expect(Array.from(output)).toEqual([0, 1, 2, 3, 4, 5, 0xFFFF, 8, 6, 7, 9, 8, 0xFFFF, 6, 7, 8]);
  });

  it('works for difficult example', () => {
    const indices = Uint32Array.from([
      1, 2, 3,  //
      0, 1, 2,  //
      0, 2, 3,  //
    ]);
    const origTriangles = getTrianglesFromIndices(indices);
    const output = computeTriangleStrips(new Uint32Array(indices));
    // console.log('indices', Array.from(indices));
    // console.log('output', Array.from(output));
    const newTriangles = getTrianglesFromStrips(output);
    expect(newTriangles).toEqual(origTriangles);
    // expect(Array.from(output)).toEqual([0, 1, 2, 3, 4, 5, 0xFFFF, 8, 6, 7, 9, 8]);
  });

  it('works for random examples', () => {
    const numVertices = 10;
    const numTriangles = 20;
    for (let iter = 0; iter < 10; ++iter) {
      const indices = makeRandomIndices(numTriangles, numVertices);
      const origTriangles = getTrianglesFromIndices(indices);
      const output = computeTriangleStrips(new Uint32Array(indices));
      // console.log('indices', Array.from(indices));
      // console.log('output', Array.from(output));
      const newTriangles = getTrianglesFromStrips(output);
      expect(newTriangles).toEqual(origTriangles);
    }
  });


  it('works for random partitioned examples', () => {
    const numVertices = 10;
    const numTriangles = 20 + 30 + 40 + 50;
    for (let iter = 0; iter < 10; ++iter) {
      const indices = makeRandomIndices(numTriangles, numVertices);
      const subChunkOffsets =
          Uint32Array.of(0, 20 * 3, (20 + 30) * 3, (20 + 30 + 40) * 3, (20 + 30 + 40 + 50) * 3);
      const outputSubChunkOffsets = new Uint32Array(subChunkOffsets);
      const output = computeTriangleStrips(new Uint32Array(indices), outputSubChunkOffsets);
      // console.log('indices', Array.from(indices));
      // console.log('output', Array.from(output));
      for (let subChunk = 0; subChunk < 4; ++subChunk) {
        const outputBegin = outputSubChunkOffsets[subChunk],
              outputEnd = outputSubChunkOffsets[subChunk + 1];
        expect(outputBegin).toBeLessThanOrEqual(outputEnd);
        expect(outputBegin).toBeGreaterThanOrEqual(0);
        expect(outputEnd).toBeLessThanOrEqual(output.length);
        const newTriangles = getTrianglesFromStrips(output.subarray(outputBegin, outputEnd));
        const origTriangles = getTrianglesFromIndices(
            indices.subarray(subChunkOffsets[subChunk], subChunkOffsets[subChunk + 1]));

        expect(newTriangles).toEqual(origTriangles);
      }
    }
  });
});

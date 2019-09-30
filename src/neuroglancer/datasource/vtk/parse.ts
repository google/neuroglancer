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

/**
 * @file
 * Parser for VTK file format.
 * See http://www.vtk.org/wp-content/uploads/2015/04/file-formats.pdf
 */

const maxHeaderLength = 1000;

const vtkHeaderPattern =
    /^[ \t]*#[ \t]+vtk[ \t]+DataFile[ \t]+Version[ \t]+([^\s]+)[ \t]*\n(.*)\n[ \t]*(ASCII|BINARY)[ \t]*\n[ \t]*DATASET[ \t]+([^ ]+)[ \t]*\n/;

const pointDataHeaderPattern = /^[ \t]*POINT_DATA[ \t]+([0-9]+)[ \t]*$/;

const pointsHeaderPattern = /^[ \t]*POINTS[ \t]+([0-9]+)[ \t]+([^\s]+)[ \t]*$/;
const scalarsHeaderPattern = /^[ \t]*SCALARS[ \t]+([^\s]+)[ \t]+([^\s]+)(?:[ \t]+([0-9]+))?[ \t]*$/;
const scalarsLookupTableHeaderPattern = /^[ \t]*LOOKUP_TABLE[ \t]+([^\s]+)[ \t]*$/;
const polygonsHeaderPattern = /^[ \t]*POLYGONS[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/;

const trianglePattern = /^[ \t]*3[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/;

const blankLinePattern = /^[ \t]*$/;

export interface VTKHeader {
  version: string;
  comment: string;
  datasetType: string;
  dataFormat: string;
}

export interface VertexAttribute {
  name: string;
  data: Float32Array;
  numComponents: number;
  tableName: string;
  dataType: string;
}

export class TriangularMesh {
  constructor(
      public header: VTKHeader, public numVertices: number, public vertexPositions: Float32Array,
      public numTriangles: number, public indices: Uint32Array,
      public vertexAttributes: VertexAttribute[]) {}
}

export function getTriangularMeshSize(mesh: TriangularMesh) {
  let size = mesh.vertexPositions.byteLength + mesh.indices.byteLength;
  for (const attribute of mesh.vertexAttributes) {
    size += attribute.data.byteLength;
  }
  return size;
}

function parsePolydataAscii(header: VTKHeader, data: ArrayBufferView): TriangularMesh {
  let decoder = new TextDecoder();
  const text = decoder.decode(data);
  const lines = text.split('\n');
  const numLines = lines.length;
  let lineNumber = 0;

  let numVertices = -1;
  let vertexPositions: Float32Array|undefined = undefined;
  let numTriangles = -1;
  let indices: Uint32Array|undefined = undefined;

  let vertexAttributes = new Array<VertexAttribute>();

  function parseArray(fieldName: string, n: number, numComponents: number, _dataType: string) {
    // TODO(jbms): respect dataType
    let pattern = RegExp(
        '^[ \t]*' +
        '([^\s]+)[ \t]+'.repeat(numComponents - 1) + '([^\s]+)[ \t]*$');
    if (numLines - lineNumber < n) {
      throw new Error(`VTK data ended unexpectedly while parsing ${fieldName}.`);
    }
    let result = new Float32Array(n * numComponents);
    let outIndex = 0;
    for (let i = 0; i < n; ++i) {
      const line = lines[lineNumber++];
      const m = line.match(pattern);
      if (m === null) {
        throw new Error(`Failed to parse ${fieldName} line ${i}: ${JSON.stringify(line)}.`);
      }
      for (let j = 0; j < numComponents; ++j) {
        result[outIndex++] = parseFloat(m[j + 1]);
      }
    }
    return result;
  }

  function parsePoints(nVertices: number, dataType: string) {
    if (indices !== undefined) {
      throw new Error(`POINTS specified more than once.`);
    }
    numVertices = nVertices;
    vertexPositions = parseArray('POINTS', nVertices, 3, dataType);
  }

  function parsePolygons(numFaces: number, numValues: number) {
    if (indices !== undefined) {
      throw new Error(`VERTICES specified more than once.`);
    }
    if (numLines - lineNumber < numFaces) {
      throw new Error(`VTK data ended unexpectedly`);
    }
    if (numValues !== numFaces * 4) {
      throw new Error(`Only triangular faces are supported.`);
    }
    numTriangles = numFaces;
    indices = new Uint32Array(numFaces * 3);
    let outIndex = 0;
    for (let i = 0; i < numFaces; ++i) {
      let m = lines[lineNumber++].match(trianglePattern);
      if (m === null) {
        throw new Error(`Failed to parse indices for face ${i}`);
      }
      indices[outIndex++] = parseInt(m[1], 10);
      indices[outIndex++] = parseInt(m[2], 10);
      indices[outIndex++] = parseInt(m[3], 10);
    }
  }

  function parseScalars(name: string, dataType: string, numComponents: number) {
    if (lineNumber === numLines) {
      throw new Error(`Expected LOOKUP_TABLE directive.`);
    }
    let firstLine = lines[lineNumber++];
    let match = firstLine.match(scalarsLookupTableHeaderPattern);
    if (match === null) {
      throw new Error(`Expected LOOKUP_TABLE directive in ${JSON.stringify(firstLine)}.`);
    }
    let tableName = match[1];
    const values = parseArray(`SCALARS(${name})`, numVertices, numComponents, dataType);
    vertexAttributes.push({name, data: values, numComponents, dataType, tableName});
  }

  function parsePointData(nVertices: number) {
    if (numVertices !== nVertices) {
      throw new Error(
          `Number of vertices specified in POINT_DATA section (${nVertices}) ` +
          `must match number of points (${numVertices}).`);
    }
    while (lineNumber < numLines) {
      let line = lines[lineNumber];
      if (line.match(blankLinePattern)) {
        ++lineNumber;
        continue;
      }
      let match: RegExpMatchArray|null;
      match = line.match(scalarsHeaderPattern);
      if (match !== null) {
        let numComponents: number;
        if (match[3] === undefined) {
          numComponents = 1;
        } else {
          numComponents = parseInt(match[3], 10);
        }
        ++lineNumber;
        parseScalars(match[1], match[2], numComponents);
        continue;
      }
    }
  }

  while (lineNumber < numLines) {
    let line = lines[lineNumber];
    if (line.match(blankLinePattern)) {
      ++lineNumber;
      continue;
    }
    let match: RegExpMatchArray|null;
    match = line.match(pointsHeaderPattern);
    if (match !== null) {
      ++lineNumber;
      parsePoints(parseInt(match[1], 10), match[2]);
      continue;
    }
    match = line.match(polygonsHeaderPattern);
    if (match !== null) {
      ++lineNumber;
      parsePolygons(parseInt(match[1], 10), parseInt(match[2], 10));
      continue;
    }
    match = line.match(pointDataHeaderPattern);
    if (match !== null) {
      ++lineNumber;
      parsePointData(parseInt(match[1], 10));
      break;
    }
    throw new Error(`Failed to parse VTK line ${JSON.stringify(line)}.`);
  }

  if (vertexPositions === undefined) {
    throw new Error(`Vertex positions not specified.`);
  }
  if (indices === undefined) {
    throw new Error(`Indices not specified.`);
  }
  return new TriangularMesh(
      header, numVertices, vertexPositions, numTriangles, indices, vertexAttributes);
}

const asciiFormatParsers = new Map([['POLYDATA', parsePolydataAscii]]);

export function parseVTK(data: ArrayBufferView): TriangularMesh {
  // Decode start of data as UTF-8 to determine whether it is ASCII or BINARY format.  Decoding
  // errors (as will occur if it is binary format) will be ignored.
  let decoder = new TextDecoder();
  const decodedHeaderString = decoder.decode(
      new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, maxHeaderLength)));
  const headerMatch = decodedHeaderString.match(vtkHeaderPattern);
  if (headerMatch === null) {
    throw new Error(`Failed to parse VTK file header.`);
  }
  const byteOffset = headerMatch[0].length;
  const datasetType = headerMatch[4];
  const dataFormat = headerMatch[3];
  const header: VTKHeader = {
    version: headerMatch[1],
    comment: headerMatch[2],
    datasetType,
    dataFormat,
  };
  const remainingData =
      new Uint8Array(data.buffer, data.byteOffset + byteOffset, data.byteLength - byteOffset);
  if (dataFormat === 'ASCII') {
    const formatParser = asciiFormatParsers.get(datasetType);
    if (formatParser === undefined) {
      throw new Error(`VTK dataset type ${JSON.stringify(datasetType)} is not supported.`);
    }
    return formatParser(header, remainingData);
  }
  throw new Error(`VTK data format ${JSON.stringify(dataFormat)} is not supported.`);
}

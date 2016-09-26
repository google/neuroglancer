import {each} from 'lodash';
import {decodeSkeletonVertexPositionsAndIndices, ParameterizedSkeletonSource, SkeletonChunk} from 'neuroglancer/skeleton/backend';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';

export function decodeSwcSkeletonChunk(
    chunk: SkeletonChunk, swc_str: string, endianness: Endianness) {
  let swc_objects: Array<PointObj> = parseSwc(swc_str);
  console.log(swc_objects);
  if (swc_objects.length < 2) {
    throw new Error(`ERROR parsing swc file`);
  }

  let gl_vertices = new Float32Array(3 * (swc_objects.length));  // Array<number> = [];
  let gl_indices = new Uint32Array(2 * (swc_objects.length - 1));

  each(swc_objects, function(swc_obj, i) {
    gl_vertices[3 * i] = swc_obj.z;
    gl_vertices[3 * i + 1] = swc_obj.y;
    gl_vertices[3 * i + 2] = swc_obj.x;

    if (swc_obj.parent !== -1) {
      gl_indices[2 * (i - 1)] = i;
      gl_indices[2 * i - 1] = swc_obj.parent;
    }
  });

  chunk.indices = gl_indices;
  chunk.vertexPositions = gl_vertices;
  convertEndian32(chunk.indices, endianness);
  convertEndian32(chunk.vertexPositions, endianness);
}

/*
 * Parses a standard SWC file into an array of point objects
 * modified from
 * https://github.com/JaneliaSciComp/SharkViewer/blob/d9969a7c513beee32ff9650b00bf79cda8f3c76a/html/js/sharkviewer_loader.js
 */
function parseSwc(swc_str: string) {
  // split by line
  let swc_input_ar = swc_str.split('\n');
  let swc_objects_ar: Array<PointObj> = new Array();
  let float = '-?\\d*(?:\\.\\d+)?';
  let pattern = new RegExp('^[ \\t]*(' + [
    '\\d+',    // index
    '\\d+',    // type
    float,     // x
    float,     // y
    float,     // z
    float,     // radius
    '-1|\\d+'  // parent
  ].join(')[ \\t]+(') + ')[ \\t]*$');

  each(swc_input_ar, function(e) {
    // if line meets swc point criteria, add it to the array
    // subtract 1 from indices to convert 1-indexing to 0-indexing
    let match = e.match(pattern);
    if (match) {
      let point = swc_objects_ar[parseInt(match[1], 10) - 1] = new PointObj();
      point.type = parseInt(match[2], 10);
      point.x = parseFloat(match[3]);
      point.y = parseFloat(match[4]);
      point.z = parseFloat(match[5]);
      point.radius = parseFloat(match[6]);
      point.parent = parseInt(match[7], 10) - 1;
    }
  });
  return swc_objects_ar;
}

class PointObj {
  type: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  parent: number;
}

import {SkeletonChunk} from 'neuroglancer/skeleton/backend';

export function decodeSwcSkeletonChunk(chunk: SkeletonChunk, swcStr: string) {
  let swcObjects: Array<PointObj> = parseSwc(swcStr);
  if (swcObjects.length < 2) {
    throw new Error(`ERROR parsing swc file`);
  }

  let glVertices = new Float32Array(3 * (swcObjects.length));
  let glIndices = new Uint32Array(2 * (swcObjects.length - 1));

  swcObjects.forEach(function(swc_obj, i) {
    glVertices[3 * i] = swc_obj.z;
    glVertices[3 * i + 1] = swc_obj.y;
    glVertices[3 * i + 2] = swc_obj.x;

    if (swc_obj.parent !== -1) {
      glIndices[2 * (i - 1)] = i;
      glIndices[2 * i - 1] = swc_obj.parent;
    }
  });

  chunk.indices = glIndices;
  chunk.vertexPositions = glVertices;
}

/*
 * Parses a standard SWC file into an array of point objects
 * modified from
 * https://github.com/JaneliaSciComp/SharkViewer/blob/d9969a7c513beee32ff9650b00bf79cda8f3c76a/html/js/sharkviewer_loader.js
 */
function parseSwc(swcStr: string) {
  // split by line
  let swcInputAr = swcStr.split('\n');
  let swcObjectsAr: Array<PointObj> = new Array();
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

  swcInputAr.forEach(function(e) {
    // if line meets swc point criteria, add it to the array
    // subtract 1 from indices to convert 1-indexing to 0-indexing
    let match = e.match(pattern);
    if (match) {
      let point = swcObjectsAr[parseInt(match[1], 10) - 1] = new PointObj();
      point.type = parseInt(match[2], 10);
      point.x = parseFloat(match[3]);
      point.y = parseFloat(match[4]);
      point.z = parseFloat(match[5]);
      point.radius = parseFloat(match[6]);
      point.parent = parseInt(match[7], 10) - 1;
    }
  });
  return swcObjectsAr;
}

class PointObj {
  type: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  parent: number;
}

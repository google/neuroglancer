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

import {registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {PointMatchChunkSourceParameters, TileChunkSourceParameters} from 'neuroglancer/datasource/render/base';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {ParameterizedVectorGraphicsChunkSource, VectorGraphicsChunk} from 'neuroglancer/sliceview/vector_graphics/backend';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Float32ArrayBuilder} from 'neuroglancer/util/float32array_builder';
import {vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpJsonPostRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, verify3dVec, verifyObject, verifyString} from 'neuroglancer/util/json';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('jpg', decodeJpegChunk);

@registerChunkSource(TileChunkSourceParameters)
export class TileChunkSource extends ParameterizedVolumeChunkSource<TileChunkSourceParameters> {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let {chunkGridPosition} = chunk;

    // Calculate scale.
    let scale = 1.0 / Math.pow(2, parameters.level);

    // Needed by JPEG decoder.
    chunk.chunkDataSize = this.spec.chunkDataSize;

    let xTileSize = chunk.chunkDataSize[0] * Math.pow(2, parameters.level);
    let yTileSize = chunk.chunkDataSize[1] * Math.pow(2, parameters.level);

    // Convert grid position to global coordinates position.
    let chunkPosition = vec3.create();

    chunkPosition[0] = chunkGridPosition[0] * xTileSize;
    chunkPosition[1] = chunkGridPosition[1] * yTileSize;
    chunkPosition[2] = chunkGridPosition[2];

    // GET
    // /v1/owner/{owner}/project/{project}/stack/{stack}/z/{z}/box/{x},{y},{width},{height},{scale}/jpeg-image
    let path = `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project}/` +
        `stack/${parameters.stack}/z/${chunkPosition[2]}/` +
        `box/${chunkPosition[0]},${chunkPosition[1]},${xTileSize},${yTileSize},${scale}/jpeg-image`;

    return sendHttpRequest(
               openShardedHttpRequest(parameters.baseUrls, path), 'arraybuffer', cancellationToken)
        .then(response => this.chunkDecoder(chunk, response));
  }
}

function decodeSectionIDs(response: any) {
  let sectionIDs: string[] = [];
  parseArray(response, x => {
    verifyObject(x);
    sectionIDs.push(verifyString(x['sectionId']));
  });
  return sectionIDs;
}

function createConversionObject(tileId: string, xcoord: any, ycoord: any) {
  return {'tileId': tileId, 'local': [xcoord, ycoord]};
}

function conversionObjectToWorld(
    conversionObjectArray: Array<any>, parameters: PointMatchChunkSourceParameters,
    cancellationToken: CancellationToken) {
  let path = `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project}/` +
      `stack/${parameters.stack}/local-to-world-coordinates`;
  return sendHttpJsonPostRequest(
      openShardedHttpRequest(parameters.baseUrls, path, 'PUT'), conversionObjectArray, 'json',
      cancellationToken);
}

function decodePointMatches(
    chunk: VectorGraphicsChunk, response: any, parameters: PointMatchChunkSourceParameters,
    cancellationToken: CancellationToken) {
  let conversionObjects = new Array<any>();

  parseArray(response, (matchObj) => {
    let pId = verifyString(matchObj['pId']);
    let qId = verifyString(matchObj['qId']);
    let matches = verifyObject(matchObj['matches']);

    let pMatches = matches['p'];  // [[x],[y]]
    let qMatches = matches['q'];

    // Create conversion objects
    for (let i = 0; i < pMatches[0].length; i++) {
      // Create pConversion
      conversionObjects.push(createConversionObject(pId, pMatches[0][i], pMatches[1][i]));
      // Create qConversion
      conversionObjects.push(createConversionObject(qId, qMatches[0][i], qMatches[1][i]));
    }
  });

  return conversionObjectToWorld(conversionObjects, parameters, cancellationToken)
      .then(allConvertedCoordinates => {
        let vertexPositions = new Float32ArrayBuilder();
        for (let i = 0; i < allConvertedCoordinates.length; i++) {
          let convertedCoordinate = verifyObject(allConvertedCoordinates[i]);
          let point = verify3dVec(convertedCoordinate['world']);
          vertexPositions.appendArray(point);
        }
        chunk.vertexPositions = vertexPositions.view;
      });
}

function getPointMatches(
    chunk: VectorGraphicsChunk, sectionIds: string[], parameters: PointMatchChunkSourceParameters,
    cancellationToken: CancellationToken) {
  let path: string;
  if (sectionIds.length === 1) {
    path = `/render-ws/v1/owner/${parameters.owner}/matchCollection/` +
        `${parameters.matchCollection}/group/${sectionIds[0]}/matchesWith/${sectionIds[0]}`;
  } else if (sectionIds.length === 2) {
    path = `/render-ws/v1/owner/${parameters.owner}/matchCollection/` +
        `${parameters.matchCollection}/group/${sectionIds[0]}/matchesWith/${sectionIds[1]}`;
  } else {
    throw new Error(`Invalid section Id vector of length: ${JSON.stringify(sectionIds.length)}`);
  }

  return sendHttpRequest(
             openShardedHttpRequest(parameters.baseUrls, path), 'json', cancellationToken)
      .then(response => {
        return decodePointMatches(chunk, response, parameters, cancellationToken);
      });
}


function downloadPointMatchChunk(
    chunk: VectorGraphicsChunk, path: string, parameters: PointMatchChunkSourceParameters,
    cancellationToken: CancellationToken): Promise<void> {
  return sendHttpRequest(
             openShardedHttpRequest(parameters.baseUrls, path), 'json', cancellationToken)
      .then(response => {
        return getPointMatches(chunk, decodeSectionIDs(response), parameters, cancellationToken);
      });
}

@registerChunkSource(PointMatchChunkSourceParameters)
export class PointMatchSource extends
    ParameterizedVectorGraphicsChunkSource<PointMatchChunkSourceParameters> {
  download(chunk: VectorGraphicsChunk, cancellationToken: CancellationToken): Promise<void> {
    let {parameters} = this;
    let {chunkGridPosition} = chunk;
    // Convert grid position to global coordinates
    let chunkPosition = vec3.create();
    chunkPosition[2] = chunkGridPosition[2];

    // Get section IDs
    let path = `/render-ws/v1/owner/${parameters.owner}/project/${parameters.project}/` +
        `stack/${parameters.stack}/sectionData?minZ=${chunkPosition[2]}&` +
        `maxZ=${chunkPosition[2] + parameters.zoffset}`;

    return downloadPointMatchChunk(chunk, path, parameters, cancellationToken);
  }
}

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

import {glsl_getPositionWithinChunk} from 'neuroglancer/sliceview/volume/renderlayer';
import {SingleTextureChunkFormat} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {getFortranOrderStrides} from 'neuroglancer/util/array';
import {TypedArray} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {Disposable} from 'neuroglancer/util/disposable';
import {vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {GL} from 'neuroglancer/webgl/context';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

export function chunkFormatTest<TextureLayout extends Disposable>(
    dataType: DataType, volumeSize: vec4,
    getChunkFormatAndTextureLayout:
        (gl: GL) => [SingleTextureChunkFormat<TextureLayout>, TextureLayout],
    rawData: TypedArray, encodedData: TypedArray) {
  const numChannels = volumeSize[3];
  let strides = getFortranOrderStrides(volumeSize);
  let outputChannelsPerChannel = dataType === DataType.UINT64 ? 2 : 1;
  it(`volumeSize = ${vec3Key(volumeSize)}, numChannels = ${volumeSize[3]}, dataType = ${DataType[dataType]}`,
     () => {
       fragmentShaderTest(outputChannelsPerChannel * numChannels, tester => {
         let {gl, builder} = tester;
         let [chunkFormat, textureLayout] = getChunkFormatAndTextureLayout(gl);
         builder.addUniform('vec3', 'vChunkPosition');
         builder.addUniform('vec3', 'uChunkDataSize');
         builder.addFragmentCode(glsl_getPositionWithinChunk);
         chunkFormat.defineShader(builder);
         {
           let fragmentMain = '';
           let outputChannel = 0;
           for (let channel = 0; channel < numChannels; ++channel) {
             switch (dataType) {
               case DataType.UINT64:
                 fragmentMain += `
{
  uint64_t value = getDataValue(${channel});
  gl_FragData[${outputChannel++}] = value.low;
  gl_FragData[${outputChannel++}] = value.high;
}
`;
                 break;
               case DataType.UINT8:
                 fragmentMain += `
gl_FragData[${outputChannel++}] = vec4(getDataValue(${channel}).value, 0, 0, 0);
`;
                 break;
               case DataType.FLOAT32:
                 fragmentMain += `
gl_FragData[${outputChannel++}] = packFloatIntoVec4(getDataValue(${channel}));
`;
                 break;
               case DataType.UINT16:
                 fragmentMain += `
gl_FragData[${outputChannel++}] = vec4(getDataValue(${channel}).value, 0, 0);
`;
                 break;
               case DataType.UINT32:
                 fragmentMain += `
gl_FragData[${outputChannel++}] = getDataValue(${channel}).value;
`;
                 break;
             }
           }
           builder.setFragmentMain(fragmentMain);
         }
         tester.build();
         let {shader} = tester;
         shader.bind();
         gl.uniform3fv(shader.uniform('uChunkDataSize'), volumeSize.subarray(0, 3));

         let texture = gl.createTexture();
         tester.registerDisposer(() => { gl.deleteTexture(texture); });

         chunkFormat.beginDrawing(gl, shader);
         gl.bindTexture(gl.TEXTURE_2D, texture);
         chunkFormat.setTextureData(gl, textureLayout, encodedData);
         chunkFormat.setupTextureLayout(gl, shader, textureLayout);


         // Position within chunk in floating point range [0, chunkDataSize].
         function checkPosition(positionInChunk: vec3) {
           gl.uniform3fv(shader.uniform('vChunkPosition'), positionInChunk);
           chunkFormat.beginDrawing(gl, shader);
           chunkFormat.beginSource(gl, shader);
           chunkFormat.setupTextureLayout(gl, shader, textureLayout);
           gl.bindTexture(gl.TEXTURE_2D, texture);
           tester.execute();
           chunkFormat.endDrawing(gl, shader);
           let offset = 0;
           for (let i = 0; i < 3; ++i) {
             offset += Math.floor(Math.max(0, Math.min(positionInChunk[i], volumeSize[i] - 1))) *
                 strides[i];
           }
           let outputChannel = 0;
           for (let channel = 0; channel < numChannels; ++channel) {
             const curOffset = offset + channel * strides[3];
             const msg =
                 `volumeSize = ${vec3Key(volumeSize)}, positionInChunk = ${vec3Key(positionInChunk)}, channel = ${channel}, offset = ${curOffset}`;
             switch (dataType) {
               case DataType.UINT64: {
                 let low = tester.readUint32(outputChannel++);
                 let high = tester.readUint32(outputChannel++);
                 expect(low).toEqual(rawData[curOffset * 2], `${msg} (low)`);
                 expect(high).toEqual(rawData[curOffset * 2 + 1], `${msg} (high)`);
                 break;
               }
               case DataType.FLOAT32: {
                 let result = tester.readFloat(outputChannel++);
                 expect(result).toEqual(rawData[curOffset], msg);
                 break;
               }
               default: {
                 // uint8, uint16, and uint32 values can all be read as uint32.
                 let result = tester.readUint32(outputChannel++);
                 expect(result).toEqual(rawData[curOffset], msg);
                 break;
               }
             }
           }
         }
         checkPosition(vec3.fromValues(0, 0, 1));
         checkPosition(vec3.fromValues(0, 1, 0));
         checkPosition(vec3.fromValues(0, volumeSize[1], 0));
         checkPosition(vec3.fromValues(0, volumeSize[1], volumeSize[2]));
         checkPosition(vec3.fromValues(volumeSize[0], volumeSize[1], volumeSize[2]));

         const COUNT = 100;
         for (let iter = 0; iter < COUNT; ++iter) {
           let vChunkPosition = vec3.create();
           for (let i = 0; i < 3; ++i) {
             vChunkPosition[i] = Math.random() * volumeSize[i];
           }
           checkPosition(vChunkPosition);
         }
       });
     });
}

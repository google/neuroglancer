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

import {SingleTextureChunkFormat} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {glsl_getPositionWithinChunk} from 'neuroglancer/sliceview/volume/renderlayer';
import {getFortranOrderStrides} from 'neuroglancer/util/array';
import {TypedArray} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {Disposable} from 'neuroglancer/util/disposable';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {GL} from 'neuroglancer/webgl/context';
import {textureTargetForSamplerType} from 'neuroglancer/webgl/shader';
import {fragmentShaderTest, FragmentShaderTestOutputs} from 'neuroglancer/webgl/shader_testing';

export function chunkFormatTest<TextureLayout extends Disposable>(
    dataType: DataType, volumeSize: Uint32Array,
    getChunkFormatAndTextureLayout:
        (gl: GL) => [SingleTextureChunkFormat<TextureLayout>, TextureLayout],
    rawData: TypedArray, encodedData: TypedArray) {
  const numChannels = volumeSize[3];
  let strides = getFortranOrderStrides(volumeSize);
  const outputType = dataType === DataType.FLOAT32 ? 'float' : 'uint';
  const outputs: FragmentShaderTestOutputs = {};
  for (let channelIndex = 0; channelIndex < numChannels; ++channelIndex) {
    if (dataType === DataType.UINT64) {
      outputs[`output${channelIndex}Low`] = outputType;
      outputs[`output${channelIndex}High`] = outputType;
    } else {
      outputs[`output${channelIndex}`] = outputType;
    }
  }
  it(`volumeSize = ${volumeSize.join()}, numChannels = ${volumeSize[3]}, ` +
         `dataType = ${DataType[dataType]}`,
     () => {
       fragmentShaderTest(outputs, tester => {
         let {gl, builder} = tester;
         let [chunkFormat, textureLayout] = getChunkFormatAndTextureLayout(gl);
         builder.addUniform('highp vec3', 'vChunkPosition');
         builder.addUniform('vec3', 'uChunkDataSize');
         builder.addFragmentCode(glsl_getPositionWithinChunk);
         chunkFormat.defineShader(builder, /*numChannelDimensions=*/ 1);
         {
           let fragmentMain = '';
           for (let channel = 0; channel < numChannels; ++channel) {
             switch (dataType) {
               case DataType.UINT64:
                 fragmentMain += `
{
  uint64_t value = getDataValue(${channel});
  output${channel}Low = value.value[0];
  output${channel}High = value.value[1];
}
`;
                 break;
               case DataType.FLOAT32:
                 fragmentMain += `
output${channel} = getDataValue(${channel});
`;
                 break;
               default:
                 fragmentMain += `
output${channel} = getDataValue(${channel}).value;
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
         tester.registerDisposer(() => {
           gl.deleteTexture(texture);
         });
         const textureTarget = textureTargetForSamplerType[chunkFormat.shaderSamplerType];
         chunkFormat.beginDrawing(gl, shader);
         gl.bindTexture(textureTarget, texture);
         chunkFormat.setTextureData(gl, textureLayout, encodedData);
         const fixedChunkPosition = Uint32Array.of(0, 0, 0);
         const chunkDisplaySubspaceDimensions = [0, 1, 2];
         chunkFormat.setupTextureLayout(
             gl, shader, textureLayout, fixedChunkPosition, chunkDisplaySubspaceDimensions,
             /*channelDimensions=*/[3]);


         // Position within chunk in floating point range [0, chunkDataSize].
         function checkPosition(positionInChunk: vec3) {
           gl.uniform3fv(shader.uniform('vChunkPosition'), positionInChunk);
           chunkFormat.beginDrawing(gl, shader);
           chunkFormat.beginSource(gl, shader);
           chunkFormat.setupTextureLayout(
               gl, shader, textureLayout, fixedChunkPosition, chunkDisplaySubspaceDimensions,
               /*channelDimensions=*/[3]);
           gl.bindTexture(textureTarget, texture);
           tester.execute();
           chunkFormat.endDrawing(gl, shader);
           let offset = 0;
           for (let i = 0; i < 3; ++i) {
             offset += Math.floor(Math.max(0, Math.min(positionInChunk[i], volumeSize[i] - 1))) *
                 strides[i];
           }
           const values = tester.values;
           for (let channel = 0; channel < numChannels; ++channel) {
             const curOffset = offset + channel * strides[3];
             const msg = `volumeSize = ${vec3Key(volumeSize)}, ` +
                 `positionInChunk = ${vec3Key(positionInChunk)}, ` +
                 `channel = ${channel}, offset = ${curOffset}`;
             switch (dataType) {
               case DataType.UINT64: {
                 let low = values[`output${channel}Low`];
                 let high = values[`output${channel}High`];
                 expect(low).toBe(rawData[curOffset * 2], `${msg} (low)`);
                 expect(high).toEqual(rawData[curOffset * 2 + 1], `${msg} (high)`);
                 break;
               }
               default: {
                 let result = values[`output${channel}`];
                 expect(result).toBe(rawData[curOffset], msg);
                 break;
               }
             }
           }
         }
         checkPosition(vec3.fromValues(0, 0, 0));
         checkPosition(vec3.fromValues(0, 0, 1));
         checkPosition(vec3.fromValues(0, 1, 0));
         checkPosition(vec3.fromValues(0, volumeSize[1], 0));
         checkPosition(vec3.fromValues(0, volumeSize[1], volumeSize[2]));
         checkPosition(vec3.fromValues(volumeSize[0], volumeSize[1], volumeSize[2]));
         checkPosition(vec3.fromValues(volumeSize[0] - 1, 1, 1));

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

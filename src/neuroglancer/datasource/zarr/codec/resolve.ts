/**
 * @license
 * Copyright 2023 Google Inc.
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

import {CodecArrayInfo, CodecArrayLayoutInfo, CodecChainSpec, CodecKind, CodecSpec, ShardingInfo} from 'neuroglancer/datasource/zarr/codec';
import {parseNameAndConfiguration} from 'neuroglancer/datasource/zarr/metadata/parse';
import {parseArray} from 'neuroglancer/util/json';

function getCodecResolver(obj: unknown): {resolver: CodecResolver, configuration: unknown} {
  const {name: resolver, configuration} = parseNameAndConfiguration(obj, name => {
    const resolver = codecRegistry.get(name);
    if (resolver === undefined) {
      throw new Error(`Unknown codec: ${JSON.stringify(name)}`);
    }
    return resolver;
  }, configuration => configuration);
  return {resolver, configuration};
}

export interface CodecResolver {
  name: string;
  kind: CodecKind;
}

export interface ArrayToArrayCodecResolver<Configuration> extends CodecResolver {
  kind: CodecKind.arrayToArray;
  resolve(configuration: unknown, decodedArrayInfo: CodecArrayInfo): {
    configuration: Configuration,
    encodedArrayInfo: CodecArrayInfo,
  };
  getDecodedArrayLayoutInfo(
      configuration: Configuration, decodedArrayInfo: CodecArrayInfo,
      encodedLayout: CodecArrayLayoutInfo): CodecArrayLayoutInfo;
}

export interface ArrayToBytesCodecResolver<Configuration> extends CodecResolver {
  kind: CodecKind.arrayToBytes;
  resolve(configuration: unknown, decodedArrayInfo: CodecArrayInfo): {
    configuration: Configuration,
    shardingInfo?: ShardingInfo,
    encodedSize?: number,
  };
  getDecodedArrayLayoutInfo(configuration: Configuration, decodedArrayInfo: CodecArrayInfo):
      CodecArrayLayoutInfo;
}

export interface BytesToBytesCodecResolver<Configuration> extends CodecResolver {
  kind: CodecKind.bytesToBytes;
  resolve(configuration: unknown, decodedSize: number|undefined): {
    configuration: Configuration,
    encodedSize?: number,
  };
}

const codecRegistry = new Map<string, CodecResolver>();

export function registerCodec<Configuration>(resolver: ArrayToArrayCodecResolver<Configuration>|
                                             ArrayToBytesCodecResolver<Configuration>|
                                             BytesToBytesCodecResolver<Configuration>) {
  codecRegistry.set(resolver.name, resolver);
}

export function parseCodecChainSpec(
    obj: unknown, decodedArrayInfo: CodecArrayInfo): CodecChainSpec {
  const arrayToArray: CodecSpec<CodecKind.arrayToArray>[] = [];
  const arrayInfo: CodecArrayInfo[] = [];
  const layoutInfo: CodecArrayLayoutInfo[] = [];
  const encodedSize: (number|undefined)[] = [];

  arrayInfo.push(decodedArrayInfo);

  const codecSpecs = parseArray(obj, getCodecResolver);
  let numCodecs = codecSpecs.length;
  let i = 0;

  for (; i < numCodecs; ++i) {
    const {resolver, configuration: initialConfiguration} = codecSpecs[i];
    if (resolver.kind !== CodecKind.arrayToArray) {
      break;
    }
    const arrayResolver = resolver as ArrayToArrayCodecResolver<unknown>;
    const {configuration, encodedArrayInfo} =
        arrayResolver.resolve(initialConfiguration, decodedArrayInfo);
    arrayInfo.push(encodedArrayInfo);
    decodedArrayInfo = encodedArrayInfo;
    arrayToArray.push({kind: CodecKind.arrayToArray, name: resolver.name, configuration});
  }

  if (i === numCodecs || codecSpecs[i].resolver.kind !== CodecKind.arrayToBytes) {
    throw new Error('Missing array -> bytes codec');
  }

  const {
    codecSpec: arrayToBytes,
    layoutInfo: finalLayoutInfo,
    encodedSize: initialEncodedSize,
    shardingInfo
  } = (() => {
    const {resolver, configuration: initialConfiguration} = codecSpecs[i];
    const arrayToBytesResolver = resolver as ArrayToBytesCodecResolver<unknown>;
    const {configuration, shardingInfo, encodedSize} =
        arrayToBytesResolver.resolve(initialConfiguration, decodedArrayInfo);
    if (shardingInfo !== undefined) {
      if (i + 1 !== numCodecs) {
        throw new Error(`bytes -> bytes codecs not supported following sharding codec`);
      }
    }
    const layoutInfo =
        arrayToBytesResolver.getDecodedArrayLayoutInfo(configuration, decodedArrayInfo);
    const codecSpec: CodecSpec<CodecKind.arrayToBytes> = {
      name: resolver.name,
      kind: CodecKind.arrayToBytes,
      configuration
    };
    return {codecSpec, layoutInfo, encodedSize, shardingInfo};
  })();

  layoutInfo[i] = finalLayoutInfo;
  encodedSize.push(initialEncodedSize);
  const curEncodedSize = initialEncodedSize;

  const bytesToBytes: CodecSpec<CodecKind.bytesToBytes>[] = [];

  ++i;

  while (i < numCodecs) {
    const {resolver, configuration: initialConfiguration} = codecSpecs[i];
    if (resolver.kind !== CodecKind.bytesToBytes) {
      throw new Error(`Expected bytes -> bytes codec, but received ${
          JSON.stringify(resolver.name)} of kind ${CodecKind[resolver.kind]}`);
    }
    const bytesResolver = resolver as BytesToBytesCodecResolver<unknown>;
    const {configuration, encodedSize: newEncodedSize} =
        bytesResolver.resolve(initialConfiguration, curEncodedSize);
    bytesToBytes.push({name: resolver.name, kind: resolver.kind, configuration});
    encodedSize.push(newEncodedSize);
    ++i;
  }

  for (let j = arrayToArray.length - 1; j >= 0; --j) {
    layoutInfo[j] = (codecSpecs[j].resolver as ArrayToArrayCodecResolver<unknown>)
                        .getDecodedArrayLayoutInfo(
                            arrayToArray[j].configuration, arrayInfo[j], layoutInfo[j + 1]);
  }

  return {
    [CodecKind.arrayToArray]: arrayToArray,
    [CodecKind.arrayToBytes]: arrayToBytes,
    [CodecKind.bytesToBytes]: bytesToBytes,
    arrayInfo,
    layoutInfo,
    shardingInfo,
    encodedSize,
  };
}

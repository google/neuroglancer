import type {
  CodecChainSpec,
  Codec,
  CodecArrayInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";

interface ArrayToBytesCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.arrayToBytes;
  encode(
    configuration: Configuration,
    encodedArrayInfo: CodecArrayInfo,
    decoded: ArrayBufferView,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

interface BytesToBytesCodec<Configuration = unknown> extends Codec {
  kind: CodecKind.bytesToBytes;
  encode(
    configuration: Configuration,
    decoded: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

const codecRegistry = {
  [CodecKind.arrayToBytes]: new Map<string, ArrayToBytesCodec>(),
  [CodecKind.bytesToBytes]: new Map<string, BytesToBytesCodec>(),
};

export function registerCodec<Configuration>(
  codec: ArrayToBytesCodec<Configuration> | BytesToBytesCodec<Configuration>,
) {
  codecRegistry[codec.kind].set(codec.name, codec as any);
}

export async function encodeArray(
  codecs: CodecChainSpec,
  decoded: ArrayBufferView<ArrayBufferLike>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (codecs[CodecKind.arrayToArray].length > 0) {
    throw new Error("array -> array codecs are not supported for writing.");
  }

  const arrayToBytesCodecSpec = codecs[CodecKind.arrayToBytes];
  const arrayToBytesImpl = codecRegistry[CodecKind.arrayToBytes].get(
    arrayToBytesCodecSpec.name,
  );
  if (!arrayToBytesImpl) {
    throw new Error(
      `Unsupported array -> bytes codec for writing: ${arrayToBytesCodecSpec.name}`,
    );
  }
  const arrayInfo = codecs.arrayInfo[codecs.arrayInfo.length - 1];
  let data = await arrayToBytesImpl.encode(
    arrayToBytesCodecSpec.configuration,
    arrayInfo,
    decoded,
    signal,
  );

  for (const codecSpec of codecs[CodecKind.bytesToBytes]) {
    const bytesToBytesImpl = codecRegistry[CodecKind.bytesToBytes].get(
      codecSpec.name,
    );
    if (!bytesToBytesImpl) {
      throw new Error(
        `Unsupported bytes -> bytes codec for writing: ${codecSpec.name}`,
      );
    }
    data = await bytesToBytesImpl.encode(codecSpec.configuration, data, signal);
  }

  return data;
}

import type { Configuration } from "#src/datasource/zarr/codec/bytes/resolve.js";
import { registerCodec } from "#src/datasource/zarr/codec/encode.js";
import {
  type CodecArrayInfo,
  CodecKind,
} from "#src/datasource/zarr/codec/index.js";
import { DATA_TYPE_BYTES } from "#src/sliceview/base.js";
import { convertEndian } from "#src/util/endian.js";

registerCodec({
  name: "bytes",
  kind: CodecKind.arrayToBytes,
  async encode(
    configuration: Configuration,
    encodedArrayInfo: CodecArrayInfo,
    decoded: ArrayBufferView,
  ): Promise<Uint8Array> {
    const bytesPerElement = DATA_TYPE_BYTES[encodedArrayInfo.dataType];
    convertEndian(decoded, configuration.endian, bytesPerElement);
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  },
});

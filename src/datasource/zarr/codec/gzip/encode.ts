import { registerCodec } from "#src/datasource/zarr/codec/encode.js";
import type { Configuration } from "#src/datasource/zarr/codec/gzip/resolve.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { encodeGzip } from "#src/util/gzip.js";

for (const [name, compressionFormat] of [
  ["gzip", "gzip"],
  ["zlib", "deflate"],
] as const) {
  registerCodec({
    name,
    kind: CodecKind.bytesToBytes,
    async encode(
      configuration: Configuration,
      decoded: Uint8Array,
    ): Promise<Uint8Array> {
      configuration;
      const result = await encodeGzip(decoded, compressionFormat);
      return new Uint8Array(result);
    },
  });
}

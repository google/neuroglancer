import { encodeBlosc } from "#src/async_computation/encode_blosc_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { Configuration } from "#src/datasource/zarr/codec/blosc/resolve.js";
import { registerCodec } from "#src/datasource/zarr/codec/encode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";

registerCodec({
  name: "blosc",
  kind: CodecKind.bytesToBytes,
  encode(configuration: Configuration,
         decoded: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return requestAsyncComputation(encodeBlosc, signal, [decoded.buffer], decoded, configuration);
  },
});

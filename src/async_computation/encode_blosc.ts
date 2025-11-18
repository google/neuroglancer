import { encodeBlosc } from "#src/async_computation/encode_blosc_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";

registerAsyncComputation(encodeBlosc, async (data, config) => {
  const { default: Blosc } = await import("numcodecs/blosc");
  const codec = Blosc.fromConfig({ id: "blosc", ...config });
  const result = await codec.encode(data);
  return { value: result, transfer: [result.buffer] };
});

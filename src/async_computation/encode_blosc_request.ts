import { asyncComputation } from "#src/async_computation/index.js";

export const encodeBlosc =
  asyncComputation<(data: Uint8Array, config: any) => Uint8Array>(
    "encodeBlosc",
  );

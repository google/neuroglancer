/**
 * @license
 * Copyright 2025.
 */

import { decodeJxl } from "#src/async_computation/decode_jxl_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpegxl/resolve.js";

registerCodec({
  name: "jpegxl",
  kind: CodecKind.bytesToBytes,
  async decode(
    configuration: Configuration,
    encoded: Uint8Array,
    signal: AbortSignal,
  ) {
    signal;
    // Determine bytesPerPixel from bitspersample.
    let bytesPerPixel: 1 | 2 | 4;
    switch (configuration.bitspersample) {
      case 16:
        bytesPerPixel = 2;
        break;
      case 32:
        bytesPerPixel = 4;
        break;
      default:
        bytesPerPixel = 1;
        break; // 8-bit or unknown -> assume 1
    }

    // Infer spatial area (x*y) and numComponents (channels) from chunkShape.
    if (!configuration.chunkShape || configuration.chunkShape.length < 2) {
      throw new Error(
        "jpegxl: missing or invalid chunkShape for area inference",
      );
    }
    const shape = configuration.chunkShape;
    // Identify trailing non-singleton dims for spatial (x,y[,z]). Take last two as x,y.
    let x = 1,
      y = 1,
      z = 1; // width, height, depth
    for (let i = shape.length - 1; i >= 0; --i) {
      if (x === 1) {
        x = shape[i];
        continue;
      }
      if (z === 1) {
        z = shape[i];
        continue;
      }
      if (y === 1) {
        y = shape[i];
        break;
      }
    }
    const area = x * y * z;

    // Channel inference: first dimension with value 3 or 4 outside of the trailing two spatial dims.
    let numComponents = 1;
    for (let i = 0; i < shape.length - 2; ++i) {
      const v = shape[i];
      if (v === 3 || v === 4) {
        numComponents = v;
        break;
      }
    }

    const decoded = await requestAsyncComputation(
      decodeJxl,
      signal,
      [encoded.buffer],
      encoded,
      area,
      numComponents,
      bytesPerPixel,
    );

    // Validate total bytes against chunkElements if provided.
    if (configuration.chunkElements && decoded.uint8Array) {
      const bytesPerVoxel = bytesPerPixel * numComponents;
      const expectedBytes = configuration.chunkElements * bytesPerVoxel;
      if (decoded.uint8Array.byteLength !== expectedBytes) {
        console.warn(
          `jpegxl: decoded bytes ${decoded.uint8Array.byteLength} != expected ${expectedBytes} (chunkElements=${configuration.chunkElements}, bytesPerVoxel=${bytesPerVoxel}).`,
        );
      }
    }
    return decoded.uint8Array;
  },
});

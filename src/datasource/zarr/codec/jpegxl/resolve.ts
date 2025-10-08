/**
 * @license
 * Copyright 2025.
 */

// bytesToBytes codecs do not receive full decoded array shape info at resolve time; they only
// get the decoded byte size from the previous stage via the resolve API in parseCodecChainSpec.
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyOptionalObjectProperty } from "#src/util/json.js";

export interface Configuration {
  bitspersample: number | null;
  chunkElements?: number; // total elements in the chunk (product of chunkShape)
  chunkShape?: number[]; // raw chunk shape (logical order)
}

registerCodec({
  name: "jpegxl",
  kind: CodecKind.bytesToBytes,
  resolve(configuration: unknown, _decodedSize: number | undefined) {
    // decodedSize is the size in bytes output by the preceding arrayToBytes codec (if known).
    // For jpegxl we can't map that directly without bitspersample; we just carry through fields.
    verifyObject(configuration);
    const bitspersample = verifyOptionalObjectProperty(
      configuration,
      "bitspersample",
      (x) => (typeof x === "number" ? x : null),
      null,
    );
    const chunkElements = verifyOptionalObjectProperty(
      configuration,
      "chunkElements",
      (x) => (typeof x === "number" ? x : undefined),
      undefined,
    );
    const chunkShape = verifyOptionalObjectProperty(
      configuration,
      "chunkShape",
      (x) =>
        Array.isArray(x)
          ? x
              .map((v) => (typeof v === "number" ? v : NaN))
              .filter((v) => Number.isFinite(v))
          : undefined,
      undefined,
    );
    return {
      configuration: {
        bitspersample,
        chunkElements,
        chunkShape,
      },
    };
  },
});

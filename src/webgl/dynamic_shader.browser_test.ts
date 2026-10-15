import { describe, expect, it } from "vitest";
import { RefCounted } from "#src/util/disposable.js";
import {
  makeAggregateWatchableShaderError,
  makeWatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import { ShaderCompilationError } from "#src/webgl/shader.js";

describe("makeAggregateWatchableShaderError", () => {
  it("does not let one shader success clear another shader error", () => {
    const refCounted = new RefCounted();
    const volumeError = makeWatchableShaderError();
    const meshError = makeWatchableShaderError();
    const offscreenError = makeWatchableShaderError();
    const aggregate = makeAggregateWatchableShaderError(refCounted, [
      volumeError,
      meshError,
      offscreenError,
    ]);
    const error = Object.create(ShaderCompilationError.prototype);

    volumeError.value = error;
    meshError.value = null;
    offscreenError.value = null;

    expect(aggregate.value).toBe(error);
    volumeError.value = null;
    expect(aggregate.value).toBeNull();
    refCounted.dispose();
  });
});

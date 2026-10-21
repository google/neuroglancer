import { describe, expect, test } from "vitest";
import {
  getAnnotationFilterAdjustedRenderScaleTarget,
  MAX_ANNOTATION_FILTER_OVERSAMPLING,
} from "#src/annotation/base.js";

describe("getAnnotationFilterAdjustedRenderScaleTarget", () => {
  test("preserves the target without filtering", () => {
    expect(getAnnotationFilterAdjustedRenderScaleTarget(8, 1)).toBe(8);
  });

  test("increases source density inversely with the match fraction", () => {
    expect(getAnnotationFilterAdjustedRenderScaleTarget(8, 0.25)).toBe(4);
  });

  test("limits oversampling for rare and empty results", () => {
    const minimumTarget = 8 / Math.sqrt(MAX_ANNOTATION_FILTER_OVERSAMPLING);
    expect(getAnnotationFilterAdjustedRenderScaleTarget(8, 0)).toBeCloseTo(
      minimumTarget,
    );
    expect(getAnnotationFilterAdjustedRenderScaleTarget(8, 1e-6)).toBeCloseTo(
      minimumTarget,
    );
  });
});

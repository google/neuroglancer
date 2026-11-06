import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_GONE,
  ATTRIBUTE_HIDDEN,
  attributeClassColor,
  attributeColor,
  SegmentAttributeTables,
} from "#src/segmentation_display_state/attributes.js";

const instance = (classIndex: number, flags = 0) =>
  BigInt(classIndex) | (BigInt(flags) << 32n);
const cls = (rgba: number, root: number, flags = 0) =>
  BigInt(rgba >>> 0) | (BigInt(((root << 8) | flags) >>> 0) << 32n);

function tables() {
  const t = new SegmentAttributeTables();
  t.classes.set(1n, cls(0xff000000, 1));
  t.classes.set(2n, cls(0x00ff0000, 1));
  t.classes.set(3n, cls(0x0000ff00, 3, ATTRIBUTE_HIDDEN));
  return t;
}

const rgb = (c: Float32Array) => Array.from(c.subarray(0, 3));

describe("attribute colors", () => {
  it("a hidden id has its class color but does not draw", () => {
    const t = tables();
    t.instances.set(5n, instance(1, ATTRIBUTE_HIDDEN));
    t.instances.set(6n, instance(3));
    for (const id of [5n, 6n]) {
      const color = new Float32Array(4);
      expect(attributeColor(t, id, color)).toBe(false);
      expect(attributeClassColor(t, id, color)).toBe(true);
    }
    const color = new Float32Array(4);
    attributeClassColor(t, 6n, color);
    expect(rgb(color)).toEqual([0, 0, 1]);
  });

  it("both resolve a merged class to its root's color", () => {
    const t = tables();
    t.instances.set(7n, instance(2));
    const drawn = new Float32Array(4);
    const classed = new Float32Array(4);
    expect(attributeColor(t, 7n, drawn)).toBe(true);
    expect(attributeClassColor(t, 7n, classed)).toBe(true);
    expect(rgb(drawn)).toEqual([1, 0, 0]);
    expect(rgb(classed)).toEqual([1, 0, 0]);
  });

  it("a gone id still has a class color; an unknown id has none", () => {
    const t = tables();
    t.instances.set(8n, instance(1, ATTRIBUTE_GONE));
    const color = new Float32Array(4);
    expect(attributeColor(t, 8n, color)).toBe(false);
    expect(attributeClassColor(t, 8n, color)).toBe(true);
    expect(attributeClassColor(t, 9n, color)).toBe(false);
  });
});

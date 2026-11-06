import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

export const ATTRIBUTE_HIDDEN = 1;
export const ATTRIBUTE_GONE = 2;
export const ATTRIBUTE_SHOWN = 4;

// Render attributes the embedding app keeps for the ids and classes on screen.
// While `enabled`, the 2D segmentation shader colors and hides by these instead
// of the visible set and stated colors, and an id with no entry is transparent;
// 3D draws only the visible ids these say to draw, in their class color.
//   instances: voxel id → class index (low 32) | flags (high 32)
//   classes:   class index → rgba 0xRRGGBBAA (low 32) | root << 8 | flags (high 32)
// An id is hidden by its own HIDDEN / SHOWN flag, else its root class's, else
// `hideByDefault`. Write the tables in bulk, then dispatch `changed` once.
export class SegmentAttributeTables {
  instances = new HashMapUint64();
  classes = new HashMapUint64();
  enabled = new WatchableValue(false);
  hideByDefault = false;
  changed = new NullarySignal();
}

// The CPU twin of the shaders' hidden test, on the instance and class flags.
export function attributesHidden(
  instanceFlags: number,
  classFlags: number,
  hideByDefault: boolean,
): boolean {
  if (instanceFlags & ATTRIBUTE_HIDDEN) return true;
  if (instanceFlags & ATTRIBUTE_SHOWN) return false;
  if (classFlags & ATTRIBUTE_HIDDEN) return true;
  if (classFlags & ATTRIBUTE_SHOWN) return false;
  return hideByDefault;
}

const GONE = BigInt(ATTRIBUTE_GONE);

// The segment whose mesh is the layer mesh: always drawn, its
// features colored and hidden one by one through the tables.
export const MESH_SEGMENT = 0xffffffffffffffffn;

// The CPU twin of the 2D shader's getAttributeColor: writes the class rgb of a
// raw id into `color`; false when it should not draw.
export function attributeColor(
  tables: SegmentAttributeTables,
  id: bigint,
  color: Float32Array,
): boolean {
  const attrs = tables.instances.get(id);
  if (attrs === undefined || ((attrs >> 32n) & GONE) !== 0n) return false;
  const cls = rootClass(tables, attrs);
  if (cls === undefined || ((cls >> 32n) & GONE) !== 0n) return false;
  const instanceFlags = Number((attrs >> 32n) & 0xffn);
  const classFlags = Number((cls >> 32n) & 0xffn);
  if (attributesHidden(instanceFlags, classFlags, tables.hideByDefault)) {
    return false;
  }
  writeRgb(cls, color);
  return true;
}

// The class rgb of a raw id whether or not it draws; false when it has none.
export function attributeClassColor(
  tables: SegmentAttributeTables,
  id: bigint,
  color: Float32Array,
): boolean {
  const attrs = tables.instances.get(id);
  const cls = attrs === undefined ? undefined : rootClass(tables, attrs);
  if (cls === undefined) return false;
  writeRgb(cls, color);
  return true;
}

function rootClass(
  tables: SegmentAttributeTables,
  attrs: bigint,
): bigint | undefined {
  const classIndex = attrs & 0xffffffffn;
  if (classIndex === 0n) return undefined;
  const cls = tables.classes.get(classIndex);
  if (cls === undefined) return undefined;
  const root = cls >> 40n;
  return root === classIndex ? cls : tables.classes.get(root);
}

function writeRgb(cls: bigint, color: Float32Array) {
  const rgba = Number(cls & 0xffffffffn);
  color[0] = ((rgba >>> 24) & 0xff) / 255;
  color[1] = ((rgba >>> 16) & 0xff) / 255;
  color[2] = ((rgba >>> 8) & 0xff) / 255;
}

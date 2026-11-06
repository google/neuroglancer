import { DataType } from "#src/util/data_type.js";

// Unordered; runs of one label skip the set.
export function distinctLabels(
  data: ArrayBufferView,
  dataType: DataType,
): BigUint64Array {
  const words = new Uint32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength >>> 2,
  );
  if (dataType === DataType.UINT64) {
    const seen = new Set<bigint>();
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < words.length; i += 2) {
      if (words[i] === lo && words[i + 1] === hi) continue;
      lo = words[i];
      hi = words[i + 1];
      if (lo !== 0 || hi !== 0) seen.add(BigInt(lo) | (BigInt(hi) << 32n));
    }
    return BigUint64Array.from([...seen]);
  }
  const seen = new Set<number>();
  let prev = 0;
  for (const v of words) {
    if (v === prev) continue;
    prev = v;
    if (v !== 0) seen.add(v);
  }
  return BigUint64Array.from([...seen], BigInt);
}

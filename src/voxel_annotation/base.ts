export const VOX_CHUNK_SOURCE_RPC_ID = "vox.VoxChunkSource";
export const VOX_COMMIT_VOXELS_RPC_ID = "vox.commitVoxels";
export const VOX_MAP_INIT_RPC_ID = "vox.map.init";
export const VOX_LABELS_GET_RPC_ID = "vox.labels.get";
export const VOX_LABELS_ADD_RPC_ID = "vox.labels.add";
export const VOX_RELOAD_CHUNKS_RPC_ID = "vox.chunk.reload";

export function makeVoxChunkKey(chunkKey: string, lodFactor : number) {
  return `lod${lodFactor}#${chunkKey}`;
}

export function makeChunkKey(x: number, y : number, z: number) {
  return `${x},${y},${z}`;
}

export function parseVoxChunkKey(key: string) {
  const parts = [Number(key.split("#")[0].substring(3)),
    ...key.split("#")[1].split(",").map(Number)];
  if (parts.length !== 4 || parts.some(isNaN)) {
    console.warn(`Invalid chunk key format: ${key}`);
    return null;
  }
  return { lod: parts[0], x: parts[1], y: parts[2], z: parts[3], chunkKey: key.split("#")[1] };
}

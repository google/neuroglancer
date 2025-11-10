export const VOX_RELOAD_CHUNKS_RPC_ID = "vox.chunk.reload";
export const VOX_EDIT_BACKEND_RPC_ID = "vox.EditBackend";
export const VOX_EDIT_COMMIT_VOXELS_RPC_ID = "vox.edit.commitVoxels";
export const VOX_EDIT_LABELS_GET_RPC_ID = "vox.edit.labels.get";
export const VOX_EDIT_LABELS_ADD_RPC_ID = "vox.edit.labels.add";
export const VOX_EDIT_FAILURE_RPC_ID = "vox.edit.failure";

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

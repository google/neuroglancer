### What a “chunk source” is (mental model)

- Think of a gigantic 3D image (a volume). It’s too big to load at once, so we split it into many small 3D bricks called chunks (like Lego blocks). Each chunk is a small 3D array (e.g., 64×64×64 voxels).
- Now imagine the same big 3D image at multiple zoom levels (resolutions). That’s your multiscale pyramid: full-res, half-res, quarter-res, etc. Each level is also split into chunks.
- A chunk source is the object that knows how to find, prepare, and deliver those chunk bricks when the view needs them.

In Neuroglancer, the chunk source is split into:
- Frontend chunk source: lives on the main thread; it integrates with rendering (WebGL) and decides what to ask for.
- Backend chunk source: lives in a Web Worker; it actually fetches/decodes/generates the raw chunk data and streams it back over RPC.


### Why two halves (frontend vs backend)

- Rendering must remain smooth; heavy I/O and compute live off the main thread.
- The main thread (frontend) plans what to show: which parts of the 3D volume are visible, which scale is appropriate, how to transform coordinates, which chunks to request.
- The worker (backend) executes: it receives chunk requests, loads or synthesizes the bytes, and transfers ArrayBuffers back.
- The two halves are paired via an RPC system (a tiny object-remoting layer). The frontend has the “owner” object; the worker holds the “counterpart.” They are linked by a type ID and a runtime map.


### Key classes and where they fit

- MultiscaleVolumeChunkSource (frontend): a high-level source that can return sources at multiple scales/orientations. It does not deliver bytes directly; it returns per-scale frontend VolumeChunkSource owners wrapped in SliceViewSingleResolutionSource records.
- VolumeChunkSource (frontend): lower-level, per-resolution source. Holds the spec (chunk sizes, data type, bounds, etc.), integrates with WebGL via a ChunkFormatHandler, and maintains an in-memory map of loaded chunks for sampling.
- VolumeChunkSource (backend): the worker-side counterpart. It computes chunk bounds/clipping and manages Chunk instances that carry data.
- Your class DummyMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource (frontend) and returns a single-resolution source whose owner is VoxDummyChunkSource (frontend).
- VoxDummyChunkSource (frontend) extends the frontend VolumeChunkSource to set up RPC pairing (by using the same type ID as the backend class).
- VoxDummyChunkSource (backend) extends the backend VolumeChunkSource and implements download to synthesize data.


### What is in the “spec” and why it matters

- VolumeChunkSpecification (spec) is the contract that defines the chunk grid and how data is represented.
  - rank: dimensionality (3 for a 3D volume).
  - dataType: e.g., UINT32 for segmentation-like data.
  - chunkDataSize: base chunk size in voxels (e.g., [64, 64, 64]).
  - upperVoxelBound/lowerVoxelBound: global data bounds used for clipping.
  - baseVoxelOffset: the global offset of the chunk grid.
- The frontend builds this spec (e.g., via makeVolumeChunkSpecification), and it gets serialized and shipped to the backend. Both sides must agree on it.


### How a MultiscaleVolumeChunkSource hands out sources

- It returns a 2D array: outer dimension is orientations, inner dimension is scales. For many use cases it’s 1 orientation × N scales; your dummy returns 1×1.
- Each inner element is a SliceViewSingleResolutionSource containing:
  - chunkSource: the per-resolution frontend owner (VolumeChunkSource-derived class).
  - chunkToMultiscaleTransform: how to transform chunk coordinates into the multiscale/layer space (identity in your dummy).
  - clip bounds.

In your dummy implementation:
- You create spec with rank=3, dataType=UINT32, chunkDataSize=[64,64,64], upper bound ~ [1000,1000,1000].
- You get a frontend owner chunk source via chunkManager.getChunkSource(VoxDummyChunkSource, {spec}).
- You wrap it as a single SliceViewSingleResolutionSource with identity transform and return [[single]].


### What happens when rendering starts (end-to-end story)

1) Frontend builds and adds a layer that references your MultiscaleVolumeChunkSource.
2) The layer asks the source for sources at the appropriate scales and passes them to the backend via an RPC call (e.g., SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID). The payload includes references to sources and metadata like transforms and bounds.
3) During serialization, the frontend VolumeChunkSource owner is represented as a shared object reference. The worker resolves that reference to the backend counterpart via rpc.getRef.
4) The backend now has TransformedSource objects (deserializeTransformedSources) containing:
  - source: the backend VolumeChunkSource counterpart
  - transforms/bounds and precomputed layout
5) As the camera changes, the backend computes visible chunks (forEachPlaneIntersectingVolumetricChunk + chunk layouts) and schedules chunk downloads.
6) For each needed chunk, the backend asks the backend VolumeChunkSource for a Chunk, computes chunk bounds via computeChunkBounds, and calls download. In your vox dummy backend, download fills a typed array with a checkerboard pattern and attaches it to chunk.data.
7) The chunk is serialized (ArrayBuffers transferred) back to the frontend. The frontend VolumeChunkSource’s ChunkFormatHandler then uploads the bytes to GPU textures or caches them in CPU memory for sampling.
8) The render layer samples those textures to draw slices or do 3D rendering.


### The RPC binding between the two halves

- The frontend owner object calls initializeCounterpart which sends an RPC: SharedObject.new with type=<RPC_TYPE_ID> and options (e.g., spec).
- The worker must have previously registered a constructor under that same identifier via registerSharedObject("id").
- When SharedObject.new arrives in the worker:
  - worker_rpc looks up sharedObjectConstructors.get(typeName)
  - It calls new constructorFunction(rpc, options)
  - The new backend object is recorded in the RPC map and linked to the same id
- From then on, any time the frontend sends a reference {id, gen}, the worker can resolve it to the concrete backend object with rpc.getRef.

In your code:
- Frontend: VoxDummyChunkSource sets its prototype.RPC_TYPE_ID = VOX_DUMMY_CHUNK_SOURCE_RPC_ID.
- Backend: VoxDummyChunkSource is decorated with @registerSharedObject(VOX_DUMMY_CHUNK_SOURCE_RPC_ID) so it registers its constructor under the same ID.


### Why MultiscaleVolumeChunkSource exists at all

- It lets Neuroglancer render the same dataset at multiple levels of detail and orientations without changing the rest of the rendering pipeline.
- It abstracts: “here is the set of sources to use for the current view and resolution.” The core sliceview logic can then pick the best scale based on zoom and request those chunks only.


### How “a single value at a position” is read

- Frontend VolumeChunkSource.getValueAt does a small lookup:
  - Convert a voxel coordinate to a chunk grid coordinate and an index within the chunk (modulo chunk size).
  - Fetch the chunk by key from the in-memory map. If missing, return null/undefined.
  - Ask the chunk object to read the typed array at the computed offset.

This is useful for picking/hover reads and is why chunks are kept in a hash map keyed by grid position.


### Reference counting and disposal (brief)

- Both owner and counterpart are ref-counted SharedObjects. When no visible layers reference a source anymore, ref counts drop; the system eventually sends dispose messages across RPC to free memory on both sides.
- The generation fields (referencedGeneration/unreferencedGeneration) guard against stale references as messages can cross.


### Common pitfalls and quick checks (ties to earlier errors)

- The backend class not being loaded in the Worker bundle:
  - Even if you call registerSharedObject in backend.ts, it will not run unless that file is actually imported by chunk_worker.bundle.js (or one of its transitively imported modules).
  - Symptom 1: worker_rpc.ts:443 constructorFunction is not a constructor (actually undefined). That’s exactly what happens when sharedObjectConstructors.get(type) finds nothing because your backend module never ran its registration.
  - Fix: ensure src/voxel_annotation/backend.ts is imported from the worker entry (e.g., via a central “enabled backend modules” file) so the decorator executes.
- RPC type ID mismatch:
  - Frontend prototype.RPC_TYPE_ID must equal the identifier used by @registerSharedObject in the backend. If they differ, the worker won’t find a constructor.
- Wrong base classes:
  - Frontend source should extend sliceview/volume/frontend VolumeChunkSource; backend should extend sliceview/volume/backend VolumeChunkSource. Mixing these up breaks chunk and spec handling.
- Spec inconsistencies:
  - rank, dataType, and chunkDataSize must be consistent. If computeChunkBounds clips a chunk, backend must set chunk.chunkDataSize appropriately so the frontend knows the actual size.


### TL;DR flow

- You create a MultiscaleVolumeChunkSource that returns one or more per-resolution frontend VolumeChunkSources (owners) plus transforms/bounds.
- The frontend sends these to the worker; the worker resolves the backend counterparts via a shared ID system.
- The backend decides which chunks to download and calls your backend source’s download to fill typed arrays.
- Chunks are transferred back; the frontend uploads to GPU and renders.

If you want, I can sketch the minimal import line(s) needed so your vox backend class is included in chunk_worker.bundle.js, which should resolve the constructorFunction is not a constructor error you saw earlier.

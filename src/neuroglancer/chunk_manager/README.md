This directory implements the data management system at the core of Neuroglancer, which handles
prioritization, queueing, downloading, and transferring of data between CPU and GPU memory.  The
unit at which data is managed is called a *chunk*; a single chunk may correspond to:
- `64^3` voxel block of volumetric data;
- a fragment of a triangular mesh representation of an object;
- the list of mesh fragments making up a full object;
- a line segment (skeleton) representation of an object.

For better interactive responsiveness and to take advantage of multiple CPU cores, all of the data
queuing, downloading and decoding/transcoding of data chunks occurs off of the main UI JavaScript
thread on a separate WebWorker thread.

Each data chunk has a priority, which is ordered primarily by a discrete tier and secondarily by a
numeric pririoty.  The three supported tiers, in decreasing order of priority, are:
- `VISIBLE`, corresponding to data that is visible and currently needed for rendering;
- `PREFETCH`, corresponding to data expected to be visible soon;
- `RECENT`, corresponding to data that is neither visible nor needed for prefetching.  The
assignment of numeric priority depends on the specific chunk type; in the case of volumetric data
chunks used for cross-sectional views, it is assigned based on resolution and position relative to
the viewport.

Chunk management is organized around the following set of (mutually exclusive) chunk states
(see [base.ts](base.ts)):
- `QUEUED`, corresponding to chunks not yet downloaded.  Chunks not yet managed by the system that
  are requested with `VISIBLE` or `PREFETCH` priority begin in the `QUEUED` state.  Any chunk with
  only `RECENT` priority that is evicted to the `QUEUED` state is deleted from the system.
- `DOWNLOADING`, corresponding to chunks currently being retrieved over the network.  There is a
  fixed capacity on the number of simultaneous downloads supported; available capacity is filled by
  moving the highest priority chunks from the `QUEUED` state to the `DOWNLOADING` state.  If all
  available download capacity is filled, chunks in the `QUEUED` state with higher priority replace
  chunks in the `DOWNLOADING` state with lower priority (by aborting the download and evicting them
  back to the `QUEUED` state).
- `SYSTEM_MEMORY_WORKER`, corresponding to chunks that have been downloaded and are stored in system
  memory within the data management WebWorker.  Due to the lack of support in JavaScript for sharing
  memory between multiple JavaScript threads, the data must be explicitly moved between the
  WebWorker and the main UI thread.  Chunks are initially moved to this state after downloading
  completes.  Neuroglancer imposes a limit on the amount of system memory that may be used for
  storing data chunks; once the system memory capacity is filled, new chunks may be downloaded only
  by evicting a lower-priority chunk from one of the `DOWNLOADING`, `SYSTEM_MEMORY_WORKER`,
  `SYSTEM_MEMORY`, or `GPU_MEMORY` states.  Chunks that are evicted from system memory move back to
  the `QUEUED` state.
- `SYSTEM_MEMORY`, corresponding to chunks that are stored in system memory within the main UI
  thread.  Due to the limitation that WebGL operations, including data uploads to GPU memory, may
  only be performed from the main UI thread, all data must first be transferred to the main UI
  thread before it can be copied to GPU memory.
- `GPU_MEMORY`, corresponding to chunks stored in both CPU and GPU memory.  Only chunks in this
  state can be used for rendering.  Neuroglancer imposes a limit on the amount of GPU memory that
  may be used; while there is available GPU memory, data chunks in the `SYSTEM_MEMORY` or
  `SYSTEM_MEMORY_WORKER` states are moved to the `GPU_MEMORY` state and copied to GPU memory.  Once
  the GPU memory capacity is filled, higher-priority chunks in the `SYSTEM_MEMORY` or
  `SYSTEM_MEMORY_WORKER` states replace lower-priority chunks in the `GPU_MEMORY` state (by evicting
  them back to the `SYSTEM_MEMORY` state).


The promotion queue for `QUEUED` chunks and the eviction queues for download capacity, system memory
capacity, and GPU memory capacity are managed using pairing heaps to track the `VISIBLE` and
`PREFETCH` priorities and a linked list to track the `RECENT` chunks in order of least-recent use.

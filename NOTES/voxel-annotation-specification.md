# Voxel Annotation Specification (Revised)

## 1. Overview

The objective of the voxel annotation feature is to allow precise, voxel-aligned labeling of image data, primarily for deep learning training and validation. The existing annotation system in Neuroglancer is vector-based and not suited for this task. This specification outlines a new, parallel voxel annotation system designed for performance, scalability, and ergonomic use.

## 2. Core Features & Tools

The user will be provided with a suite of drawing tools for efficient annotation.

- **Brush**: A circular brush with adjustable size.
- **Flood Fill (2D/3D)**: A tool to fill contiguous areas of the same underlying data value or annotation label.
- **Eraser**: A circular eraser with adjustable size.
- **MVP Tool**: A single-voxel "Pixel" tool to validate the core architecture.

## 3. Data Storage and State Management

To ensure a responsive user experience while maintaining data integrity, we will implement a three-tier data management architecture. This formalizes the asynchronous saving process and clarifies the role of each component.

```
┌──────────────────┐   User Edit   ┌────────────────┐   (Debounced)   ┌────────────────────────┐
│   Frontend UI    ├──────────────>│  Worker State  ├────────────────>│ Persistent Storage     │
│ (Render Layer)   │               │ (Chunked Map)  │                 │  (local:// or http://) │
└──────────┬───────┘               └────────┬───────┘                 └────────────────────────┘
           │                                │
           │ User draws, updates            │ Receives edit actions,
           │ "Hot" cache instantly          │ applies to chunks, marks
           │ & sends action to worker       │ them as "dirty" for saving
           v
    [Frontend "Hot" Cache]
```

#### Tier 1: Frontend State (The "Hot" Cache)

- **Location**: Frontend (UI thread).
- **Purpose**: Provide immediate visual feedback to the user.
- **Mechanism**: When a user draws, the edit is applied to an immediate, in-memory representation and rendered instantly. Simultaneously, an "action" describing the edit is dispatched to the web worker.

#### Tier 2: Worker State (The "Warm" Source of Truth)

- **Location**: Web Worker.
- **Purpose**: To act as the authoritative, canonical state of the annotations.
- **Mechanism**: The worker maintains a map of all annotation chunks (`Map<ChunkID, ChunkData>`). It listens for actions from the frontend, applies them to the corresponding chunks, and marks those chunks as "dirty."

#### Tier 3: Persistent Storage (The "Cold" Layer)

- **Location**: The data source (e.g., `local://voxel-annotations`).
- **Purpose**: Long-term, durable storage.
- **Mechanism**: The worker uses a throttled or debounced function to periodically write all "dirty" chunks from its state (Tier 2) to the persistent data source. This ensures that frequent edits do not overload the storage backend and that the UI never waits for a save operation.

#### Tier 4: Multi-users

The arch should have all the necessary components to support multi-user annotation, such a feature could be implemented in the future. This multi-user feature would be similar to the one found in Google Docs.

### 3.1. MVP In-Memory Data Structure

For the MVP, we will simplify the problem by restricting annotations to a single, user-selectable scale. This provides a clear structure for organizing the data within the worker's memory.

- Annotation Scale Selection: The VoxUserLayer UI will include a dropdown or similar control that allows the user to select which scale (resolution) from a reference image layer they wish to annotate on. All subsequent drawing actions will apply to this single, chosen scale.
- In-Worker Data Structure: The worker will namespace the chunks in its internal Map using a key that combines the scale and chunk identifiers. This prevents collisions if the user switches between annotating different scales.
  - Map Key Format: <scale_id>/<chunk_id>
  - Example Key: "4_4_40/0-64_0-64_0-64"
- In-Memory Chunk Format:
  - Each chunk will be stored in the worker's map as a Uint32Array.
  - The total length of the array will be chunkSizeX _ chunkSizeY _ chunkSizeZ (e.g., 64x64x64 = 262,144 elements).
  - The value 0 represents an un-annotated voxel. Values 1..n correspond to different user-defined labels.

## 4. LOD, Scaling, and Performance

The absence of pre-computed mipmaps for user-drawn data presents the primary performance challenge. We will tackle this with a phased approach.

### MVP Strategy

Render annotations only at their native resolution. The annotation layer will be hidden when the view is zoomed too far out or in, avoiding the LOD problem entirely to validate the core drawing and saving functionality.

### Phase 2: On-the-Fly Worker Downsampling

- The `VoxChunkSource` will be responsible for generating lower-resolution chunks.
- When the renderer requests a chunk at a lower LOD (e.g., LOD 1), the `VoxChunkSource` will request the corresponding 8 chunks at the higher resolution (LOD 0) from the Worker State.
- It will then compute a downsampled chunk on-the-fly (e.g., using a majority vote for the label in each 2x2x2 region).
- **Caching**: Generated low-LOD chunks will be cached in the worker to avoid re-computation. This cache is invalidated when any of the underlying high-resolution data changes.

### Phase 3 (Future): Sparse Voxel Structures

For ultimate performance and memory efficiency with very sparse annotations, the worker could manage the data in a hierarchical structure like a Sparse Voxel Octree (SVO). This would be a major undertaking but would provide the most scalable solution.

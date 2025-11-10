### Requirements Document: Zarr-based Voxel Annotation Server (MVP)

#### 1) Overview and Scope
- Goal: Deliver a production-ready HTTP server to host and edit voxel annotation data (integer label volumes) stored in Zarr. The server must be easy to deploy via Docker Compose and suitable for browser clients (e.g., Neuroglancer-based UIs or custom viewers).
- Out of scope: Any form of backup, history, or undo functionality (explicitly excluded from this requirements list).

#### 2) Context and Assumptions
- Data model: 3D label volumes (`uint32` or `uint64`) chunked in Zarr v2 layout; optional multiscale hierarchy following NGFF `multiscales` attribute.
- Hosting model: Reads served over plain HTTP/HTTPS from an object store or filesystem via the app or via a CDN/reverse proxy. Writes are authenticated and validated by the app and applied to the Zarr store.
- Authentication: Unique link (magic link).
- Clients: Browser-based viewers/editors. Clients read/write whole chunks; no sub-chunk partial writes.
- Deployment target: Single-node Docker Compose for development and small teams.

#### 3) Data Format and Layout (Zarr)
- Zarr version: v2.
- Root group: `annotations.zarr/` containing:
  - `.zgroup` (group marker)
  - `.zattrs` with NGFF `multiscales` describing axes and coordinate transforms.
  - One or more arrays for scale levels: `0/`, `1/`, ... (strings).
- Array (`0/`) `.zarray` baseline (example values):
```json
{
  "zarr_format": 2,
  "shape": [Z, Y, X],
  "chunks": [64, 64, 64],
  "dtype": "uint32",
  "compressor": {"id": "zlib", "level": 5},
  "order": "C",
  "fill_value": 0
}
```
- Missing chunk semantics: Unwritten chunks are implicitly `fill_value` (0).
- Chunk addressing (v2): Files at `0/ix/iy/iz` for chunk indices `(ix, iy, iz)`.

#### 4) Functional Requirements
- Dataset discovery and metadata
  - The server exposes an endpoint to return dataset info (union of NGFF `.zattrs` and per-array `.zarray` summaries).
  - The server must report shapes, chunk sizes, dtype, fill value, and the public base URL for direct HTTP reads (if configured).
- Read operations
  - Clients can fetch chunks as raw binary blocks via the server or directly from the store/reverse proxy.
  - Missing chunks must be interpreted as background (fill value 0).
- Write operations
  - Clients upload full chunks for updates. Payload must match the logical chunk voxel count and dtype.
  - Edges: For boundary chunks smaller than full chunk size, the server accepts a full-sized block and writes only the in-bounds subregion.
  - Concurrency: MVP supports last-writer-wins.
- Dataset resize
  - Resize for expanding the array shape (Zarr `resize`).
- Authentication and authorization
  - Magic link token required for all endpoints.
- Multi-scale (optional)
  - The server lists available scales; reading/writing operates per selected scale path (string).

#### 5) Non-Functional Requirements
- Performance
  - Target chunk size: 64 cubed for labels. Throughput goal: at least hundreds of chunk reads/s and tens of chunk writes/s on a single node with local/S3-like storage.
  - Compression: zlib (level 5) or zstd; deterministic compressor to keep payloads predictable.
- Availability
  - Single instance acceptable for MVP; health checks and graceful shutdown required.
- Consistency
  - Per-chunk write is atomic from the client perspective. Readers may observe eventual consistency on object stores.
- Security
  - CORS: Allow configured origins; methods `GET, HEAD, PUT, OPTIONS`.
- Caching
  - Metadata: short `Cache-Control` (e.g., 60s) with ETags. Chunks: cacheable but consider short TTLs during active editing. Avoid long-lived caching of 404s.
- Observability
  - Structured logs for all requests with dataset id, path, role, status, duration, payload size.
  - Basic metrics: request counts, latencies, error codes, chunk read/write counters.
- Portability
  - Storage backends via fsspec-compatible URLs (`file://`, S3, etc.). Docker-compose provides local S3-compatible MinIO for development.

#### 6) API Specification (HTTP, JSON/binary)
- GET `/info`
  - Response: datasets metadata including `publicBase` URL and a list of arrays: `{ path, shape, chunks, dtype, fill_value, compressor }`.
- GET `/chunk?mapId=<mapId>&chunkKey=<chunkKey>`
  - Response: `application/octet-stream` raw bytes of a full chunk in row-major order with array dtype. Edge chunks are padded to full chunk size.
- PUT `/chunk?mapId=<mapId>&chunkKey=<chunkKey>`
  - Request body: raw bytes matching `chunks[0]*chunks[1]*chunks[2]*dtype.itemsize`.
  - Behavior: Writes the corresponding chunk region. For edge chunks, only in-bounds subset is written.
  - Response: JSON `{ status: "ok" }` on success.
- GET `/init?mapId=<mapId>&scaleKey=<scaleKey>&dtype=<uint32|uint64>`
  - Behavior: Init a new map with id mapId, and sets up its metadata. If a map already exists, return an error.
  - Response: `{ status: "ok" }` on success.
- GET `/health`
  - Response: `200 OK` if the server is ready and can reach the storage.

scale key calculation:
```ts
export function toScaleKey(
  chunkDataSize: number[] | Uint32Array,
  baseVoxelOffset?: number[] | Uint32Array | Float32Array,
  upperVoxelBound?: number[] | Uint32Array | Float32Array,
): string {
  const cds = Array.from(chunkDataSize);
  const lower = Array.from(baseVoxelOffset ?? [0, 0, 0]);
  const upper = Array.from(upperVoxelBound ?? [0, 0, 0]);
  return `${cds[0]}_${cds[1]}_${cds[2]}:${lower[0]}_${lower[1]}_${lower[2]}-${upper[0]}_${upper[1]}_${upper[2]}`; // "cx_cy_cz:lx_ly_lz-ux_uy_uz" -> "64_64_64:0_0_0-1024_1024_1024"
}
```

chunk key calculation:
```ts
export function toChunkKey(
  chunkIndices: number[] | Uint32Array,
): string {
  const cis = Array.from(chunkIndices);
  return `${cis[0]},${cis[1]},${cis[2]}`; // "cx,cy,cz" -> "0,0,0"
}
```

#### 7) Storage and Infrastructure
- Backends: Local filesystem or S3-compatible object store. Docker Compose includes MinIO for local S3-like storage.
- Directory and object naming
  - One Zarr root per dataset (MVP). Scale arrays named `"0"`, `"1"`, ...

#### 8) Deployment Architecture
- Components
  - App server: Hosts the HTTP API, performs auth, validates input, reads/writes Zarr store.
  - Object store: MinIO (compose); durable storage for Zarr.
- Read flow: Client → App → Store → App → Client.
- Write flow: Client → App → Store (write) → App response.

#### 9) Configuration
- Environment variables (app)
  - `ZARR_URL`: Zarr root URL (`file://` or `s3://zarr/annotations.zarr`).
  - `PUBLIC_BASE`: Public base URL for direct reads (optional).
  - `CORS_ORIGINS`: Comma-separated origins allowed.
- Environment variables (MinIO)
  - `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`.
- Volumes
  - Persistent volume for MinIO data.
  - Optional bind mount for filesystem-backed Zarr.

#### 10) Health, Logging, and Metrics
- Health endpoint: `GET /health` returns 200 when app is ready and can reach storage.
- Logging: JSON logs with timestamp, method, path, dataset id, http status, latency ms, bytes.

#### 13) Risks and Mitigations
- Object-store eventual consistency: Edge cases where a just-written chunk isn’t visible immediately; mitigate with read-after-write via the app or retries.
- Misconfigured CORS: Prevents browser access; provide a CORS self-test on `/info`.
- Payload mismatch (size/dtype): Strict validation and clear error messages.

#### 14) Operational Runbook (MVP)
- First start
  - `docker compose up -d`
  - Visit `http://localhost:8042/info?token=...` with a valid magic link token to verify connection, server should provide a token throw its console
  - Connect neuroglancer to `zarr://http://localhost:8042/?token=...`, create a new map and try drawing

/**
 * @license
 * Copyright 2018 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ChunkStateListener, WithParameters} from 'neuroglancer/chunk_manager/backend';
import {Chunk} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {ComputationParameters, getArrayView} from 'neuroglancer/datasource/computed/base';
import {ComputedVolumeChunkSourceParameters} from 'neuroglancer/datasource/computed/base';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {decodeChannels as decodeChannels32} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint32';
import {decodeChannels as decodeChannels64} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {TypedArray} from 'neuroglancer/util/array';
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {prod3 as prod, vec3} from 'neuroglancer/util/geom';
import * as vector from 'neuroglancer/util/vector';
import {registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export abstract class VolumeComputationBackend extends SharedObjectCounterpart {
  constructor(rpc: RPC, public params: ComputationParameters) {
    super(rpc, params);
  }

  createOutputBuffer() {
    const {outputSpec} = this.params;
    return new ArrayBuffer(
        prod(outputSpec.size) * outputSpec.numChannels * DATA_TYPE_BYTES[outputSpec.dataType]);
  }

  /**
   * Performs a computation on the given buffer, returning the result via a
   * Promise.
   * @param inputBuffer the input buffer
   * @param cancellationToken cancellation token
   */
  abstract compute(
      inputBuffer: ArrayBuffer, cancellationToken: CancellationToken,
      chunk: ComputedVolumeChunk): Promise<ArrayBuffer>;
}

/**
 * Computes the index relative to the origin of a larger 4d volume given the
 * index relative to a fully contained sub volume. In particular this allows
 * for iteration along a subregion of a volume using linear indices.
 * @param idx the linear index into a subregion
 * @param offset the subregion's offset relative to the overall volume
 * @param cropSize the subregion's size
 * @param size the overal volume's size
 */
function subBoxIndex(idx: number, offset: vec3, cropSize: vec3, size: Uint32Array) {
  return idx % cropSize[0] + offset[0] +
      (Math.floor(idx / cropSize[0]) % cropSize[1] + offset[1]) * size[0] +
      (Math.floor(idx / (cropSize[0] * cropSize[1])) % cropSize[2] + offset[2]) * size[0] *
      size[1] +
      (Math.floor(idx / (cropSize[0] * cropSize[1] * cropSize[2]))) * size[0] * size[1] * size[2];
}

/**
 * Copies the overlapping region of the source array into the destination
 * array.
 * @param sourceCorner the corner (lower-bound) corresponding to the source
 *   array, in global coordinates.
 * @param sourceSize the source array's size
 * @param sourceView the source array
 * @param destCorner the corner corresponding to the destination array
 * @param destSize the destination array's size
 * @param destView the destination array
 * @param dataType the data type of both source and destintation arrays.
 */
export function copyBufferOverlap(
    sourceCorner: vec3, sourceSize: Uint32Array, sourceView: TypedArray, destCorner: vec3,
    destSize: Uint32Array, destView: TypedArray, dataType: DataType) {
  // UINT64 data is packed two-at-a-time into a UINT32 array, so we handle it as a special case.
  let copyFunction = dataType === DataType.UINT64 ? (j: number, k: number) => {
    destView[2 * k] = sourceView[2 * j];
    destView[2 * k + 1] = sourceView[2 * j + 1];
  } : (j: number, k: number) => {
    destView[k] = sourceView[j];
  };

  // Global Coordinates
  const commonLower = vec3.max(vec3.create(), sourceCorner, destCorner);
  const sourceUpper = vector.add(vec3.create(), sourceCorner, sourceSize);
  const destUpper = vector.add(vec3.create(), destCorner, destSize);
  const commonUpper = vec3.min(vec3.create(), sourceUpper, destUpper);
  const commonSize = vec3.subtract(vec3.create(), commonUpper, commonLower);

  const sourceLower = vec3.subtract(vec3.create(), commonLower, sourceCorner);
  const destLower = vec3.subtract(vec3.create(), commonLower, destCorner);


  for (let i = 0; i < prod(commonSize); ++i) {
    const j = subBoxIndex(i, /*offset=*/sourceLower, /*cropSize=*/commonSize, /*size=*/sourceSize);
    const k = subBoxIndex(i, /*offset=*/destLower, /*cropSize=*/commonSize, /*size=*/destSize);
    copyFunction(j, k);
  }
}



/**
 * Computes a consistent key string from a chunk grid position.
 *
 * It's tempting to use chunk.key, in particular because these values will
 * often be the same, but we won't always have access to a fully-specified
 * chunk, and there's no contractual guarantee that its key will be equal to
 * the value returned here.
 * @param gridPosition chunk grid position
 */
function gridPositionKey(gridPosition: TypedArray) {
  return gridPosition.join();
}

// In addition to acting as a VolumeChunk for the purposes of a ChunkManager
// object, also performs the book-keeping necessary to prepare the data buffer
// used as input by the computation that provides its data. This includes
// fetching chunk data from other datasources.
export class ComputedVolumeChunk extends VolumeChunk implements ChunkStateListener {
  // Defines the input and output geometry and datatypes.
  private computationParams_?: ComputationParameters;

  // Inidicates a cancellation of this chunk's computation.
  private cancellationToken_?: CancellationToken;

  // Resolve and reject functions correspond to a Promise, returned by getPromise().
  private resolve_?: () => void;
  private reject_?: (reason: Error) => void;

  // True iff this chunk is actively computing.
  private computing_ = false;

  // True iff this chunk has been initialized for computation.
  private initialized_ = false;

  // A map from grid position string keys, as returned by gridPositionKey to
  // vec3 grid positions. This is used as an indirection to avoid storing
  // explicit references to VolumeChunks belonging to the origin source.
  private originGridPositions_ = new Map<String, vec3>();

  // The lower bound of the input patch.
  private inputLower_?: vec3;

  // Represents the input patch.
  private inputBuffer_?: ArrayBuffer;

  // Indicate to the ChunkManager that this is a computational Chunk.
  isComputational = true;

  // Our source is a ComputedVolumeChunkSource.
  source: ComputedVolumeChunkSource;

  /**
   * Sets up computation parameters, computes overlapping origin chunks and
   * initializes the input buffer. Returns a Promise that will resolve when
   * computation completes, or reject if computation fails or is cancelled.
   * @param computationParams computation parameters
   * @param cancellationToken cancellation token
   */
  initializeComputation(
      computationParams: ComputationParameters, cancellationToken: CancellationToken) {
    if (!this.source) {
      throw new Error('initializeComputation must be called after source is valid.');
    }
    if (!this.chunkDataSize) {
      throw new Error('initializeComputation must be called after computeChunkBounds.');
    }
    this.computationParams_ = computationParams;
    this.cancellationToken_ = cancellationToken;
    this.computing_ = false;
    this.inputBuffer_ = undefined;

    this.cancellationToken_.add(() => {
      this.fail_(CANCELED);
    });
    // Compute the input bounding box for this manager
    // These computations happen without regard for edge effects, which are
    // handled post-computation by cropping to this VolumeChunk's geometry.
    const {inputSpec, outputSpec} = this.computationParams_;
    const twos = Float32Array.of(2, 2, 2);
    const outBoxLower = vector.multiply(vec3.create(), this.chunkGridPosition, outputSpec.size);
    const outputCenter =
        vec3.add(vec3.create(), outBoxLower, vector.divide(vec3.create(), outputSpec.size, twos));
    const scaleFactor = this.source.parameters.scaleFactor;
    const inputCenter = vec3.divide(vec3.create(), outputCenter, scaleFactor);
    const inputSize = inputSpec.size;
    this.inputLower_ =
        vec3.subtract(vec3.create(), inputCenter, vector.divide(vec3.create(), inputSize, twos));
    this.inputBuffer_ = new ArrayBuffer(this.systemMemoryBytes);

    this.setupSourceChunks_();
    this.initialized_ = true;

    return new Promise<void>((resolve, reject) => {
      this.resolve_ = resolve;
      this.reject_ = reject;
    });
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    const {inputSpec} = this.source.computation.params;
    const inputSize = inputSpec.size;
    const bufferLength = prod(inputSize) * inputSpec.numChannels;
    const originDataType = inputSpec.dataType;

    // Signal that we're about to take up memory. This value will be overwritten
    // post-computation by a call to decodeRawChunk.
    this.systemMemoryBytes = bufferLength * DATA_TYPE_BYTES[originDataType];
  }

  /**
   * Listens to state changes on origin Chunks.
   * @param chunk an origin Chunk.
   */
  stateChanged(chunk: Chunk) {
    const volumeChunk = <VolumeChunk>chunk;
    switch (volumeChunk.state) {
      case ChunkState.SYSTEM_MEMORY_WORKER: {
        this.copyOriginChunk_(volumeChunk);
        break;
      }
      case ChunkState.FAILED:
      case ChunkState.EXPIRED: {
        this.fail_(new Error('Data source chunk has expired.'));
        break;
      }
      case ChunkState.SYSTEM_MEMORY:
      case ChunkState.GPU_MEMORY: {
        // The data was moved to the frontend before we could intercept it, so
        // request it to be sent back.
        const gridKey = gridPositionKey(volumeChunk.chunkGridPosition);
        const chunkSize = volumeChunk.chunkDataSize!;
        const originSource = this.source.originSource;
        const chunkCorner = vector.multiply(
            vec3.create(), volumeChunk.chunkGridPosition, originSource.spec.chunkDataSize);

        this.source.requestChunkData(this, volumeChunk)
            .then((data: TypedArray) => {
              const originGridPosition = this.originGridPositions_.get(gridKey)!;
              const originChunk = <VolumeChunk>originSource.getChunk(originGridPosition);
              originChunk.unregisterListener(this);
              this.originGridPositions_.delete(gridKey);

              const inputSpec = this.computationParams_!.inputSpec;
              const destination = getArrayView(this.inputBuffer_!, inputSpec.dataType);
              const numChannels = originSource.spec.numChannels;
              const rawSource = this.maybeDecodeBuffer_(
                  data, inputSpec.dataType, originChunk.chunkDataSize!, numChannels);
              copyBufferOverlap(
                  chunkCorner, chunkSize, rawSource, this.inputLower_!, inputSpec.size, destination,
                  inputSpec.dataType);
              setTimeout(() => this.checkDone_(), 0);
            })
            .catch((error: Error) => {
              console.log(this.key!, 'unable to retrieve frontend data for', volumeChunk.key!);
              this.fail_(error);
            });
        break;
      }
    }
  }

  /**
   * Returns a list of the grid positions corresponding to chunks on the origin
   * source that this chunk overlaps.
   */
  getOverlappingOriginGridPositions() {
    return this.originGridPositions_.values();
  }

  dispose() {
    super.dispose();
    this.cleanup_();
  }

  /**
   * Unregisters listeners and so forth that were originally registered by this
   * chunk.
   */
  private cleanup_() {
    if (!this.initialized_ || !this.source) {
      return;
    }
    for (const chunkGridPosition of this.originGridPositions_.values()) {
      this.source.originSource.getChunk(chunkGridPosition).unregisterListener(this);
      this.source.cancelChunkDataRequest(gridPositionKey(chunkGridPosition), this.key!);
    }
    this.originGridPositions_.clear();
    this.source.unregisterChunk(this);
  }

  /**
   * Handles failure conditions encountered while fetching data from the origin
   * source.
   * @param reason reason for failure
   */
  private fail_(reason: Error) {
    this.cleanup_();
    this.reject_!(reason);
  }

  /**
   * Decompresses a compressed segmentation buffer, or simply passes it back if
   * raw.
   * @param buffer the possibly-compressed data buffer
   * @param dataType the buffer's datatype
   * @param size the buffer's size
   * @param numChannels the number of channels in the buffer
   */
  private maybeDecodeBuffer_(
      buffer: TypedArray, dataType: DataType, size: Uint32Array, numChannels: number) {
    const originSource = this.source.originSource;
    if (!originSource.spec.compressedSegmentationBlockSize) {
      return buffer;
    }

    const compressedBlockSize = originSource.spec.compressedSegmentationBlockSize!;
    const size4 = [size[0], size[1], size[2], numChannels];

    if (dataType === DataType.UINT32) {
      const decoded = new Uint32Array(prod(size) * numChannels);
      decodeChannels32(decoded, <Uint32Array>buffer, 0, size4, compressedBlockSize);
      return decoded;
    }

    if (dataType === DataType.UINT64) {
      const decoded = new Uint32Array(prod(size) * numChannels * 2);
      decodeChannels64(decoded, <Uint32Array>buffer, 0, size4, compressedBlockSize);
      return decoded;
    }

    throw new Error(`Compression is unsupported for datatypes other than UINT32 and UINT64`);
  }

  /**
   * Copies an origin chunk's data into the appropriate location in the input
   * buffer.
   * @param originChunk origin Chunk
   */
  private copyOriginChunk_(originChunk: VolumeChunk) {
    const inputSpec = this.computationParams_!.inputSpec;
    const gridKey = gridPositionKey(originChunk.chunkGridPosition);
    this.originGridPositions_.delete(gridKey);

    const chunkSize = originChunk.chunkDataSize!;
    const numChannels = inputSpec.numChannels;
    const chunkCorner = vector.multiply(
        vec3.create(), originChunk.chunkGridPosition, this.source.originSource.spec.chunkDataSize);

    let destination = getArrayView(this.inputBuffer_!, inputSpec.dataType);

    const source = this.maybeDecodeBuffer_(
        <TypedArray>(originChunk.data!), inputSpec.dataType, chunkSize, numChannels);

    copyBufferOverlap(
        chunkCorner, chunkSize, source, this.inputLower_!, inputSpec.size, destination,
        inputSpec.dataType);
    originChunk.unregisterListener(this);
    setTimeout(() => this.checkDone_(), 0);
  }

  /**
   * Peforms the computation over the input buffer, ensuring validity of the
   * eventual output data that will be set for this chunk. This includes
   * handling volume-boundary effects.
   */
  private performComputation_() {
    if (this.cancellationToken_!.isCanceled) {
      return Promise.reject(CANCELED);
    }
    const computation = this.source.computation;
    const {outputSpec} = this.computationParams_!;
    const outputSize = outputSpec.size;
    const outputDataType = outputSpec.dataType;

    // Most of the time, the chunk data size corresponds to the output buffer
    // size, but a chunk at the upper bound of a volume will be clipped to the
    // volume bounds. Computations are guaranteed the same buffer sizes each
    // time, so we check for this situation and perform a crop-and-copy when
    // necessary.
    return computation.compute(this.inputBuffer_!, this.cancellationToken_!, this)
        .then((outputBuffer) => {
          this.inputBuffer_ = undefined;
          if (vector.equal(outputSize, this.chunkDataSize!)) {
            return decodeRawChunk(this, this.cancellationToken_!, outputBuffer);
          }
          const outputBufferView = getArrayView(outputBuffer, outputDataType);
          const chunkBuffer = new ArrayBuffer(
              prod(this.chunkDataSize!) * outputSpec.numChannels * DATA_TYPE_BYTES[outputDataType]);
          const chunkBufferView = getArrayView(chunkBuffer, outputDataType);
          const outputCorner = vector.multiply(vec3.create(), this.chunkGridPosition, outputSize);
          copyBufferOverlap(
              outputCorner, outputSize, outputBufferView, outputCorner, this.chunkDataSize!,
              chunkBufferView, outputDataType);
          return decodeRawChunk(this, this.cancellationToken_!, chunkBuffer);
        });
  }

  /**
   * Idempotently performs the computation, if the input buffer is ready. This
   * function should be called after a timeout in most cases, because it may
   * take a long time to return.
   */
  private checkDone_() {
    if (this.computing_) {
      return;
    }
    if (this.originGridPositions_.size === 0) {
      this.computing_ = true;
      this.cleanup_();
      this.performComputation_()
          .then(() => {
            if (this.resolve_) {
              this.resolve_();
            }
          })
          .catch((error: Error) => {
            this.reject_!(error);
          });
    }
  }

  /**
   * Computes the chunkGridPosition for each valid origin chunk that the input
   * field of this computational chunk overlaps, populating the origin grid
   * positions map. Also registers this chunk as a listener on the state
   * changes of the origin chunks.
   */
  private setupSourceChunks_() {
    const originSource = this.source.originSource;
    const originChunkSize = originSource.spec.chunkDataSize;
    const inputSpec = this.computationParams_!.inputSpec;
    const inputLower = this.inputLower_!;
    const gridLower =
        vec3.floor(vec3.create(), vector.divide(vec3.create(), inputLower, originChunkSize));
    const inputSizeMinusOne =
        vector.subtract(vec3.create(), inputSpec.size, Float32Array.of(1, 1, 1));
    const inBoxUpper = vec3.add(vec3.create(), inputLower, inputSizeMinusOne);
    vec3.max(gridLower, gridLower, [0, 0, 0]);
    vector.min(inBoxUpper, inBoxUpper, originSource.spec.upperVoxelBound);
    const gridUpper =
        vec3.floor(vec3.create(), vector.divide(vec3.create(), inBoxUpper, originChunkSize));

    const gridPosition = vec3.create();
    for (let z = gridLower[2]; z <= gridUpper[2]; ++z) {
      for (let y = gridLower[1]; y <= gridUpper[1]; ++y) {
        for (let x = gridLower[0]; x <= gridUpper[0]; ++x) {
          gridPosition.set([x, y, z]);
          const key = gridPositionKey(gridPosition);
          this.originGridPositions_.set(key, vec3.copy(vec3.create(), gridPosition));
        }
      }
    }

    for (const chunkGridPosition of this.originGridPositions_.values()) {
      const chunk = originSource.getChunk(chunkGridPosition);
      chunk.registerListener(this);
      this.stateChanged(chunk);
    }
  }
}

@registerSharedObject() export class ComputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, ComputedVolumeChunkSourceParameters)) {
  // The VolumeChunkSource representing the input data over which computations
  // are performed.
  originSource: VolumeChunkSource;

  // Computations that are waiting for input data.
  private pendingComputations_ = new Map<String, ComputedVolumeChunk>();

  // Promise callbacks for pending data requests that were made to the
  // front-end, which are necessary when source data has been previously
  // downloaded and moved to the GPU. The top-level map is keyed by the origin
  // chunk keys. The inner maps are keyed by the requestor.
  private frontendRequestPromises_ = new Map<
      String, Map<String, {resolve: (data: TypedArray) => void, reject: (error: Error) => void}>>();
  public computation: VolumeComputationBackend;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.originSource = this.rpc!.getRef<VolumeChunkSource>(this.parameters.sourceRef);
    this.computation = this.rpc!.getRef<VolumeComputationBackend>(this.parameters.computationRef);
    this.registerDisposer(this.chunkManager);
    this.registerDisposer(this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
      this.updateChunkPriorities();
    }));
  }

  /**
   * Requests that the relevant chunks on the origin source are downloaded, so
   * their data may be available for computation.
   */
  updateChunkPriorities() {
    for (const outputChunk of this.pendingComputations_.values()) {
      if (outputChunk.priorityTier === ChunkPriorityTier.RECENT) {
        continue;
      }
      for (const gridPosition of outputChunk.getOverlappingOriginGridPositions()) {
        const sourceChunk = this.originSource.getChunk(gridPosition);
        this.chunkManager.requestChunk(
            sourceChunk, outputChunk.priorityTier, outputChunk.priority, false);
      }
    }
  }

  /**
   * Unregisters a ComputedVolumeChunk from the list of pending computations.
   * @param chunk the computed volume chunk to unregister
   */
  unregisterChunk(chunk: ComputedVolumeChunk) {
    const key = chunk.key!;
    this.pendingComputations_.delete(key);
  }

  /**
   * Requests chunk data that has already been moved to the frontend.
   * @param computedChunk the chunk to which data will be provided
   * @param dataChunk the chunk representing the source data.
   */
  requestChunkData(computedChunk: ComputedVolumeChunk, dataChunk: VolumeChunk) {
    return new Promise((resolve, reject) => {
      const originGridKey = gridPositionKey(dataChunk.chunkGridPosition);
      const computedChunkKey = computedChunk.key!;
      if (this.frontendRequestPromises_.has(originGridKey)) {
        this.frontendRequestPromises_.get(originGridKey)!.set(computedChunkKey, {resolve, reject});
        return;
      }
      this.frontendRequestPromises_.set(
          originGridKey, new Map([[computedChunkKey, {resolve, reject}]]));

      this.chunkManager.queueManager.retrieveChunkData(dataChunk)
          .then((data) => {
            const promiseMap = this.frontendRequestPromises_.get(originGridKey);
            if (!promiseMap) {
              // The chunk or chunks requesting this data chunk were cancelled.
              return;
            }
            for (const promisePair of promiseMap.values()) {
              promisePair.resolve(data);
            }
            this.frontendRequestPromises_.delete(originGridKey);
          })
          .catch((error) => {
            const promiseMap = this.frontendRequestPromises_.get(originGridKey);
            if (!promiseMap) {
              return;
            }
            for (const promisePair of promiseMap.values()) {
              promisePair.reject(error);
            }
            this.frontendRequestPromises_.delete(originGridKey);
          });
    });
  }

  /**
   * Cancels an outstanding chunk data request.
   * @param originGridKey the key corresponding to the requested chunk
   * @param requestKey the key corresponding to the requestor
   */
  cancelChunkDataRequest(originGridKey: string, requestKey: string) {
    if (this.frontendRequestPromises_.has(originGridKey)) {
      const map = this.frontendRequestPromises_.get(originGridKey)!;
      map.delete(requestKey);
      if (map.size === 0) {
        this.frontendRequestPromises_.delete(originGridKey);
      }
    }
  }

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const outputChunk = <ComputedVolumeChunk>chunk;
    this.computeChunkBounds(outputChunk);
    this.pendingComputations_.set(chunk.key!, outputChunk);
    const promise: Promise<void> = outputChunk.initializeComputation(this.computation.params, cancellationToken);
    this.chunkManager.scheduleUpdateChunkPriorities();
    return promise;
  }
}
ComputedVolumeChunkSource.prototype.chunkConstructor = ComputedVolumeChunk;

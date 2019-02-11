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
import {ArrayType, ComputationParameters, getArrayView} from 'neuroglancer/datasource/computed/base';
import {ComputedVolumeChunkSourceParameters} from 'neuroglancer/datasource/computed/base';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {decodeChannels as decodeChannels32} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint32';
import {decodeChannels as decodeChannels64} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {prod3 as prod, vec3} from 'neuroglancer/util/geom';
import {registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export abstract class VolumeComputationBackend extends SharedObjectCounterpart {
  constructor(rpc: RPC, public params: ComputationParameters) {
    super(rpc, params);
  }

  /**
   * Performs a computation on the given buffer.
   * @param inputSize the geometry of the input buffer.
   * @param inputDataType DataType corresponding to the input buffer.
   * @param inputBuffer the input buffer
   * @param outputSize the geometry of the output buffer.
   * @param outputDataType DataType corresponding to the output buffer.
   * @param outputBuffer the instantiated outputBuffer. This function should
   *   write its output directly into this object.
   * @param cancellationToken indicates whether this chunk has been cancelled.
   */
  abstract compute(
      inputSize: vec3, inputDataType: DataType, inputBuffer: ArrayBuffer, outputSize: vec3,
      outputDataType: DataType, outputBuffer: ArrayBuffer,
      cancellationToken: CancellationToken): Promise<void>;
}

function subBoxIndex(idx: number, offset: vec3, cropSize: vec3, size: vec3) {
  return idx % cropSize[0] + offset[0] +
      (Math.floor(idx / cropSize[0]) % cropSize[1] + offset[1]) * size[0] +
      (Math.floor(idx / (cropSize[0] * cropSize[1])) % cropSize[2] + offset[2]) * size[0] *
      size[1] +
      (Math.floor(idx / (cropSize[0] * cropSize[1] * cropSize[2]))) * size[0] * size[1] * size[2];
}

export function copyBufferOverlap(
    sourceCorner: vec3, sourceSize: vec3, sourceView: ArrayType, destCorner: vec3, destSize: vec3,
    destView: ArrayType, dataType: DataType) {
  // UINT64 data is packed two-at-a-time into a UINT32 array, so we handle it as a special case.
  let copyFunction = dataType === DataType.UINT64 ? (j: number, k: number) => {
    destView[2 * k] = sourceView[2 * j];
    destView[2 * k + 1] = sourceView[2 * j + 1];
  } : (j: number, k: number) => {
    destView[k] = sourceView[j];
  };

  // Global Coordinates
  const commonLower = vec3.max(vec3.create(), sourceCorner, destCorner);
  const sourceUpper = vec3.add(vec3.create(), sourceCorner, sourceSize);
  const destUpper = vec3.add(vec3.create(), destCorner, destSize);
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

// Computes a consistent key string from a chunk grid position.
//
// It's tempting to use chunk.key, in particular because these values will
// often be the same, but we won't always have access to a fully-specified
// chunk, and there's no contractual guarantee that its key will be equal to
// the value returned here.
function gridPositionKey(gridPosition: vec3) {
  return gridPosition.toLocaleString();
}

// In addition to acting as a VolumeChunk for the purposes of a ChunkManager
// object, also performs the book-keeping necessary to prepare the data buffer
// used as input by the computation that provides its data. This includes
// fetching chunk data from other datasources.
export class ComputedVolumeChunk extends VolumeChunk implements ChunkStateListener {
  private computationParams_?: ComputationParameters;

  private cancellationToken_?: CancellationToken;
  private resolve_?: () => void;
  private reject_?: (reason: any) => void;
  private success_ = false;
  private failure_?: any;
  private computing_ = false;

  private outputSource_?: ComputedVolumeChunkSource;
  private originGridPositions_ = new Map<String, vec3>();
  private inputLower_?: vec3;
  private inputBuffer_?: ArrayBuffer;

  private initialized_ = false;

  isComputational = true;

  // Sets up computation parameters, computes overlapping origin chunks and
  // initializes the input buffer.
  initializeComputation(
      computationParams: ComputationParameters, cancellationToken: CancellationToken) {
    if (!this.source) {
      throw new Error('initializeComputation must be called after source is valid.');
    }
    if (!this.chunkDataSize) {
      throw new Error('initializeComputation must be called after computeChunkBounds.');
    }
    this.computationParams_ = computationParams;

    this.failure_ = undefined;
    this.computing_ = false;
    this.success_ = false;
    this.outputSource_ = <ComputedVolumeChunkSource>this.source;
    this.cancellationToken_ = cancellationToken;

    this.cancellationToken_.add(() => {
      if (this.reject_) {
        this.fail_(CANCELED);
      }
    });
    // Compute the input bounding box for this manager
    // These computations happen without regard for edge effects, which are
    // handled post-computation by cropping to this VolumeChunk's geometry.
    const {inputSpec, outputSpec} = this.computationParams_;
    const twos = [2.0, 2.0, 2.0];
    const outBoxLower = vec3.multiply(vec3.create(), this.chunkGridPosition, outputSpec.size);
    const outputCenter =
        vec3.add(vec3.create(), outBoxLower, vec3.divide(vec3.create(), outputSpec.size, twos));
    const scaleFactor = this.outputSource_.parameters.scaleFactor;
    const inputCenter = vec3.divide(vec3.create(), outputCenter, scaleFactor);
    const inputSize = inputSpec.size;
    this.inputLower_ =
        vec3.subtract(vec3.create(), inputCenter, vec3.divide(vec3.create(), inputSize, twos));
    const bufferLength = prod(inputSize) * inputSpec.numChannels;
    const originDataType = inputSpec.dataType;

    // Signal that we're now taking up memory. This value will be overwritten
    // post-computation by a call to decodeRawChunk.
    this.systemMemoryBytes = bufferLength * DATA_TYPE_BYTES[originDataType];
    this.inputBuffer_ = new ArrayBuffer(this.systemMemoryBytes);

    this.setupSourceChunks_();
    this.initialized_ = true;
  }

  getPromise() {
    return new Promise<void>((resolve, reject) => {
      if (this.success_) {
        resolve();
        return;
      }
      if (this.failure_ !== undefined) {
        reject(this.failure_);
        return;
      }
      this.resolve_ = resolve;
      this.reject_ = reject;
    });
  }

  stateChanged(chunk: Chunk) {
    const volumeChunk = <VolumeChunk>chunk;
    switch (volumeChunk.state) {
      case ChunkState.SYSTEM_MEMORY_WORKER: {
        this.copyOriginChunk_(volumeChunk);
        break;
      }
      case ChunkState.FAILED:
      case ChunkState.EXPIRED: {
        this.fail_(volumeChunk.state);
        break;
      }
      case ChunkState.SYSTEM_MEMORY:
      case ChunkState.GPU_MEMORY: {
        // The data was moved to the frontend before we could intercept it, so
        // request it to be sent back.
        const gridKey = gridPositionKey(volumeChunk.chunkGridPosition);
        const chunkSize = volumeChunk.chunkDataSize!;
        const originSource = this.outputSource_!.originSource;
        const chunkCorner = vec3.multiply(
            vec3.create(), volumeChunk.chunkGridPosition, originSource.spec.chunkDataSize);

        this.outputSource_!.requestChunkData(
            volumeChunk, this.key!, (source: ArrayType, error: any) => {
              if (error) {
                console.log(this.key!, 'unable to retrieve frontend data for', volumeChunk.key!);
                this.fail_(error);
                return;
              }
              const originGridPosition = this.originGridPositions_.get(gridKey)!;
              const originChunk = <VolumeChunk>originSource.getChunk(originGridPosition);
              originChunk.unregisterListener(this);
              this.originGridPositions_.delete(gridKey);

              const inputSpec = this.computationParams_!.inputSpec;
              const destination = getArrayView(this.inputBuffer_!, inputSpec.dataType);
              const numChannels = originSource.spec.numChannels;
              const rawSource = this.maybeDecodeBuffer_(
                  source, inputSpec.dataType, originChunk.chunkDataSize!, numChannels);
              copyBufferOverlap(
                  chunkCorner, chunkSize, rawSource, this.inputLower_!, inputSpec.size, destination,
                  inputSpec.dataType);
              setTimeout(() => this.checkDone_(), 0);
            });
        break;
      }
    }
  }

  getOverlappingOriginGridPositions() {
    return this.originGridPositions_.values();
  }

  dispose() {
    super.dispose();
    this.cleanup_();
  }

  private cleanup_() {
    if (!this.initialized_) {
      return;
    }
    const outputSource = this.outputSource_!;
    for (const chunkGridPosition of this.originGridPositions_.values()) {
      outputSource.originSource.getChunk(chunkGridPosition).unregisterListener(this);
      outputSource.cancelChunkDataRequest(gridPositionKey(chunkGridPosition), this.key!);
    }
    this.originGridPositions_.clear();
    outputSource.unregisterChunk(this);
  }

  private fail_(reason: any) {
    if (this.failure_ !== undefined || this.success_) {
      return;
    }

    this.failure_ = reason;
    this.cleanup_();

    if (this.reject_) {
      // consider setTimeout(() => this.reject_(), 0);
      this.reject_(reason);
    }
  }

  // Decompresses a compressed segmentation buffer, or simply pass back if raw.
  private maybeDecodeBuffer_(
      buffer: ArrayType, dataType: DataType, size: vec3, numChannels: number) {
    const originSource = this.outputSource_!.originSource;
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

  // Copies an origin chunk's data into the appropriate location in the input
  // buffer.
  private copyOriginChunk_(originChunk: VolumeChunk) {
    const inputSpec = this.computationParams_!.inputSpec;
    const gridKey = gridPositionKey(originChunk.chunkGridPosition);
    this.originGridPositions_.delete(gridKey);

    const chunkSize = originChunk.chunkDataSize!;
    const numChannels = inputSpec.numChannels;
    const chunkCorner = vec3.multiply(
        vec3.create(), originChunk.chunkGridPosition,
        this.outputSource_!.originSource.spec.chunkDataSize);

    let destination = getArrayView(this.inputBuffer_!, inputSpec.dataType);

    const source = this.maybeDecodeBuffer_(
        <ArrayType>(originChunk.data!), inputSpec.dataType, chunkSize, numChannels);

    copyBufferOverlap(
        chunkCorner, chunkSize, source, this.inputLower_!, inputSpec.size, destination,
        inputSpec.dataType);
    originChunk.unregisterListener(this);
    setTimeout(() => this.checkDone_(), 0);
  }

  private performComputation_() {
    const computation = this.outputSource_!.computation;
    const {inputSpec, outputSpec} = this.computationParams_!;
    const outputSize = outputSpec.size;
    const outputDataType = outputSpec.dataType;
    const outputBuffer = new ArrayBuffer(
        prod(outputSize) * outputSpec.numChannels * DATA_TYPE_BYTES[outputDataType]);

    // Most of the time, the chunk data size corresponds to the output buffer
    // size, but a chunk at the upper bound of a volume will be clipped to the
    // volume bounds. Computations are guaranteed the same buffer sizes each
    // time, so we check for this situation and perform a crop-and-copy when
    // necessary.
    return computation
        .compute(
            inputSpec.size, inputSpec.dataType, this.inputBuffer_!, outputSize, outputDataType,
            outputBuffer, this.cancellationToken_!)
        .then(() => {
          this.inputBuffer_ = undefined;
          if (vec3.equals(outputSize, this.chunkDataSize!)) {
            decodeRawChunk(this, outputBuffer);
            return;
          }
          const outputBufferView = getArrayView(outputBuffer, outputDataType);
          const chunkBuffer = new ArrayBuffer(
              prod(this.chunkDataSize!) * outputSpec.numChannels * DATA_TYPE_BYTES[outputDataType]);
          const chunkBufferView = getArrayView(chunkBuffer, outputDataType);
          const outputCorner = vec3.multiply(vec3.create(), this.chunkGridPosition, outputSize);
          copyBufferOverlap(
              outputCorner, outputSize, outputBufferView, outputCorner, this.chunkDataSize!,
              chunkBufferView, outputDataType);
          decodeRawChunk(this, chunkBuffer);
        });
  }

  // Idempotently performs the computation, if the input buffer is ready. This
  // function should be called after a timeout in most cases, because it may
  // take a long time to return.
  private checkDone_() {
    if (this.failure_ || this.success_ || this.computing_) {
      return;
    }
    if (this.originGridPositions_.size === 0) {
      this.computing_ = true;
      this.performComputation_().then(() => {
        this.success_ = true;
        this.cleanup_();

        if (this.resolve_) {
          // consider setTimeout(() => this.resolve_(), 0);
          this.resolve_();
        }
      });
    }
  }

  // Computes the chunkGridPosition for each valid origin chunk that the input
  // field of this computational chunk overlaps, populating the origin grid
  // positions map.
  private setupSourceChunks_() {
    const originSource = this.outputSource_!.originSource;
    const originChunkSize = originSource.spec.chunkDataSize;
    const inputSpec = this.computationParams_!.inputSpec;
    const inputLower = this.inputLower_!;
    const gridLower =
        vec3.floor(vec3.create(), vec3.divide(vec3.create(), inputLower, originChunkSize));
    const inputSizeMinusOne = vec3.subtract(vec3.create(), inputSpec.size, [1, 1, 1]);
    const inBoxUpper = vec3.add(vec3.create(), inputLower, inputSizeMinusOne);
    vec3.max(gridLower, gridLower, [0, 0, 0]);
    vec3.min(inBoxUpper, inBoxUpper, originSource.spec.upperVoxelBound);
    const gridUpper =
        vec3.floor(vec3.create(), vec3.divide(vec3.create(), inBoxUpper, originChunkSize));

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
  originSource: VolumeChunkSource;
  private activeComputations_ = new Map<String, ComputedVolumeChunk>();
  private frontendChunkRequests_ =
      new Map<String, Map<String, (array: ArrayType, error: any) => void>>();
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

  updateChunkPriorities() {
    const priorityMap = new Map<String, {priority: number, tier: number, pos: vec3}>();

    for (const outputChunk of this.activeComputations_.values()) {
      for (const gridPosition of outputChunk.getOverlappingOriginGridPositions()) {
        const gridString = gridPosition.toLocaleString();
        if (!priorityMap.has(gridString)) {
          priorityMap.set(
              gridString,
              {priority: outputChunk.priority, tier: outputChunk.priorityTier, pos: gridPosition});
        } else {
          const currentPriority = priorityMap.get(gridString)!;
          currentPriority.priority = Math.max(currentPriority.priority, outputChunk.priority);
          currentPriority.tier = Math.min(currentPriority.tier, outputChunk.priorityTier);
        }
      }
    }

    for (const priorityInfo of priorityMap.values()) {
      const chunk = this.originSource.getChunk(priorityInfo.pos);
      if (priorityInfo.tier !== ChunkPriorityTier.RECENT) {
        this.chunkManager.requestChunk(chunk, priorityInfo.tier, priorityInfo.priority);
      }
    }
  }

  unregisterChunk(chunk: ComputedVolumeChunk) {
    const key = chunk.key!;
    this.activeComputations_.delete(key);
  }

  requestChunkData(
      chunk: VolumeChunk, key: string, callback: (array: ArrayType, error: any) => void) {
    const originGridKey = gridPositionKey(chunk.chunkGridPosition);
    if (this.frontendChunkRequests_.has(originGridKey)) {
      this.frontendChunkRequests_.get(originGridKey)!.set(key, callback);
      return;
    }
    const callbackMap = new Map<String, (array: ArrayType, error: any) => void>();
    callbackMap.set(key, callback);
    this.frontendChunkRequests_.set(originGridKey, callbackMap);
    this.chunkManager.queueManager.retrieveChunkData(chunk, originGridKey, this);
  }

  cancelChunkDataRequest(originGridKey: string, requestKey: string) {
    if (this.frontendChunkRequests_.has(originGridKey)) {
      const map = this.frontendChunkRequests_.get(originGridKey)!;
      map.delete(requestKey);
      if (map.size === 0) {
        this.frontendChunkRequests_.delete(originGridKey);
      }
    }
  }

  updateChunkData(originGridKey: string, data: any, error: any) {
    const map = this.frontendChunkRequests_.get(originGridKey);
    if (!map) {
      console.log('No callbacks found for returned chunk', originGridKey);
      return;
    }
    this.frontendChunkRequests_.delete(originGridKey);

    for (const callback of map.values()) {
      callback(<ArrayType>data, error);
    }
  }

  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const outputChunk = <ComputedVolumeChunk>chunk;
    this.computeChunkBounds(outputChunk);
    this.activeComputations_.set(chunk.key!, outputChunk);
    outputChunk.initializeComputation(this.computation.params, cancellationToken);
    this.chunkManager.scheduleUpdateChunkPriorities();
    return outputChunk.getPromise();
  }
}
ComputedVolumeChunkSource.prototype.chunkConstructor = ComputedVolumeChunk;

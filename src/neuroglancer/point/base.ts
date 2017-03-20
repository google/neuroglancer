import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {partitionArray} from 'neuroglancer/util/array';
import {SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecification, SliceViewChunkSource, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {approxEqual} from 'neuroglancer/util/compare';
import {getCombinedTransform} from 'neuroglancer/sliceview/base';
import {kAxes, rectifyTransformMatrixIfAxisAligned, vec3, kZeroVec, mat4, transformVectorByMat4} from 'neuroglancer/util/geom';
import {SharedObject} from 'neuroglancer/worker_rpc';

export interface RenderLayer { sources: PointChunkSource[][]|null; }

export interface PointSourceOptions extends SliceViewSourceOptions {}

export interface PointChunkSource extends SliceViewChunkSource { spec: PointChunkSpecification }; 

export interface PointChunkSpecificationOptions extends SliceViewChunkSpecificationBaseOptions {
    chunkDataSize: vec3
}

/**
 * Specifies a chunk layout and voxel size.
 */
export class PointChunkSpecification extends SliceViewChunkSpecification {
    chunkBytes: number;

    constructor(options: PointChunkSpecificationOptions) {
        super(options);
        
        let chunkBytes = 10000; // TODO!  remove??
    }

    static make(options: PointChunkSpecificationOptions&{pointSourceOptions: PointSourceOptions}) {
        return new PointChunkSpecification(Object.assign(
            {}, options,
            {transform: getCombinedTransform(options.transform, options.pointSourceOptions)}));
    }

    static fromObject(msg: any) { return new PointChunkSpecification(msg); }

    toObject(): PointChunkSpecificationOptions {
        return {
            transform: this.chunkLayout.transform,
            chunkDataSize: this.chunkDataSize,
            voxelSize: this.voxelSize,
            lowerVoxelBound: this.lowerVoxelBound,
            upperVoxelBound: this.upperVoxelBound,
            lowerClipBound: this.lowerClipBound,
            upperClipBound: this.upperClipBound,
            baseVoxelOffset: this.baseVoxelOffset,
        };
    }
};


export const POINT_RPC_ID = 'point';
export const POINT_RENDERLAYER_RPC_ID = 'point/RenderLayer';
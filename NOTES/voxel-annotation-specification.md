# Voxel Annotation Specification

## Overview

The objective of the voxel annotation is to allow precise labeling, synchronized with the underlying image data (same scale...), for deep learning training and validation. The already present annotation system in Neuroglancer is not well suited for this task since it is not voxel-precise, does not implement fast and ergonomic drawing tools and no export to standard formats. The choice could have been made to extend the existing annotation system, but it being based on vector graphics, it would have been a major overhaul. Instead, a new voxel annotation system is being developed in parallel.

## Tools

Giving the user modern drawing tools is one of the key requirements of the voxel annotation system. The following tools are planned:
- Brush (circular, adjustable size)
- Flood fill
- Eraser (circular, adjustable size)

For the MVP, a more simple Pixel tool (1 voxel at a time) is sufficient to validate the concept.

## LOD, scaling and performance

Similarely to the rendering of image or segmentation data, the voxel annotation data should be rendered at the appropriate LOD depending on the zoom level. But with voxel annotations we do not have access to the pre-calculated mipmaps, those should be computed on the fly, this presents a real performance challenge. This point is still under investigation, for the MVP we will avoid the issue by rendering voxel annotations only at their drawn resolution (no LOD) and hide them when zoomed out/in.

## Data storage

After investigation of the storage of the current annotation system of Neuroglancer, although not plugable to our new system, its implementation still seems well-designed for our needs. We will probably inspire ourselves to write the storage part of the voxel annotation system. The key feature relies on the asynchronous saving from the front to the back, this allows for fluid user experience (not waiting for the save to complete before being able to continue drawing). The data will be stored in a local data source (local://voxel-annotations) as a 3D array of uint32, with 0 meaning no annotation, and values 1..n meaning different labels. The data will be chunked in 64x64x64 blocks.

## Implementation plan

A new layer type should be created for voxel annotations (abv: 'vox'):
- class name: VoxUserLayer extending UserLayer
- file: layer/vox/index.ts

A local data source (local://voxel-annotations) should be created to store the voxel annotations

A subclass of MultiscaleVolumeChunkSource called VoxChunkSource should be created, this will allow us to implement custom chunk fetching to fit our special needs for the LOD, as the core algorithm for the LOD system is still not designed, this custom class will first allow us the use of single resolution chunks for the MVP while still providing a scalable solution for the future (see LOD section). In an attempt to make a "MVP of MVP", a Dummy chunk source was created, which will later be replaced by the real one.

A VoxelAnnotationRenderLayer extending SliceViewVolumeRenderLayer will allow us to render the voxel annotations.

A front/base/back arch similar to the existing annotation system should be created, this will handle the saving of the annotations and may also allow us to delegate the sampling work to the backend if sampling there is to be done for the LOD.

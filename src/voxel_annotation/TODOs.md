## TODOs

### priority

- preview colors are wrong with signed dataset
- writable float32 dataset is not working (expected), either block its usage or fix
- blosc encoding is wrong

- Dataset creation:
  - the copy from existing seems to not be right on all settings
  - upon creation of a uint64 dataset, when trying to paint, the preview is getting updated correctly, but the writing pipeline seems to fail, it causes the following error:

```
decode_common.ts:56 Uncaught TypeError: Cannot mix BigInt and other types, use explicit conversions
    at decodeValueOffset (decode_common.ts:56:32)
    at readSingleChannelValueUint64 (decode_common.ts:120:5)
    at CompressedSegmentationVolumeChunk.getValueAt (chunk_format.ts:322:42)
    at ZarrVolumeChunkSource.getValueAt (frontend.ts:286:20)
    at SegmentationRenderLayer.getValueAt (renderlayer.ts:491:29)
    at SegmentationUserLayer.getValueAt (index.ts:602:22)
    at SegmentationUserLayer.captureSelectionState (index.ts:332:24)
    at SegmentationUserLayer.captureSelectionState (annotations.ts:1943:13)
    at LayerSelectedValues.update (index.ts:1313:21)
    at LayerSelectedValues.get (index.ts:1320:10)
```

after a page reload, the painting works again with no issues; the previously painted voxels are not present.

### later

- add preview for the undo/redo
- url completion for the ssa+https source

### questionable

- write a testsuite for the downsampler and ensure its proper working on exotic lod levels
- adapt the brush size to the zoom level linearly

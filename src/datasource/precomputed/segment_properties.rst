.. _precomputed-segment-properties-format:

Neuroglancer Precomputed Segment Properties Format
==================================================

A collection of property values may be associated with uint64 segment IDs
(usually corresponding to a segmentation volume, meshes, and/or skeletons).

Currently only *inline* properties are supported, where the complete list of segment IDs and
associated property values is stored inline within the single :file:`info` JSON file.

The properties are represented by a directory containing a single :file:`info` JSON file.

:file:`info` metadata file
--------------------------

The :file:`info` file is JSON-formt text file, with the following schema:

.. json:schema:: PrecomputedSegmentProperties

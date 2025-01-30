.. _precomputed-datasource:

neuroglancer-precomputed
========================

The Neuroglancer Precomputed data format is specifically designed for efficient
interactive visualization and supports several kinds of data:

.. toctree::
   :maxdepth: 1

   Volume format<volume>
   Mesh format<mesh>
   Skeleton format<skeleton>
   Annotation format<annotation>
   Segment property format<segment_properties>

.. toctree::
   :hidden:

   Sharded format<sharded>

URL syntax
----------

- :file:`{KVSTORE-URL/}|neuroglancer-precomputed:`

The :file:`{KVSTORE-URL/}` must refer to a directory containing an :file:`info`
metadata file.

Auto detection
--------------

This data format is detected automatically based on the presence of the
:file:`info` metadata file.

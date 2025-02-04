.. _gzip-kvstore:

Gzip
====

The gzip :ref:`key-value store adapter<kvstore-adapters>` provides transparent
access to `gzip-encoded <https://en.wikipedia.org/wiki/Gzip>`__ files.

URL syntax
----------

- :file:`{base-kvstore-url}|gzip:`

The :file:`{base-kvstore-url}` must refer to a file, and typically ends with
``.gz``.

For example:

- ``gs://bucket/path/to/image.nii.gz|gzip:``

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Only prefix (byte offset of 0) byte range requests supported, if
       supported by the base key-value store.
   * - :ref:`kvstore-listing`
     - Not applicable.

.. list-table:: Required capabilities of base key-value store

   * - :ref:`kvstore-byte-range-reads`
     - Prefix (byte offset of 0) byte range requests optional.
   * - :ref:`kvstore-listing`
     - Not needed.

Auto detection
--------------

Gzip-encoded files are detected automatically based on a signature at the start
of the file.

.. _zip-kvstore:

ZIP
===

The ZIP :ref:`key-value store adapter<kvstore-adapters>` provides access to the
entries within a `ZIP archive
<https://en.wikipedia.org/wiki/ZIP_(file_format)>`__.

URL syntax
----------

- :file:`{base-kvstore-url}|zip:{path}/{to}/{entry}`

The :file:`{base-kvstore-url}` must refer to a file, and typically ends with
``.zip``.

For example:

- ``gs://bucket/path/to/image.zarr.zip|zip:path/to/array/``

.. note::

   Consistent with normal URL syntax, any special characters in the
   :file:`{path}/{to}/{entry}` must be `percent-encoded
   <https://en.wikipedia.org/wiki/Percent-encoding>`__.

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - General byte ranges supported for STORED (uncompressed) entries. Only
       prefix (byte offset of 0) byte range requests supported for DEFLATED
       entries.
   * - :ref:`kvstore-listing`
     - Supported.

.. list-table:: Required capabilities of base key-value store

   * - :ref:`kvstore-byte-range-reads`
     - Required.
   * - :ref:`kvstore-listing`
     - Not needed.

Auto detection
--------------

ZIP archives are detected automatically based on a signature at the end of the
file, provided that the end of file comment does not exceed 4096 bytes. ZIP
archives with comments up to the maximum length of 65535 bytes are still
supported without auto-detection, however.

Limitations
-----------

- Only STORED (uncompressed) and DEFLATED entries are supported.
- Encryption is not supported.
- Entries without a valid Unicode path are ignored.
- Backslashes in paths (e.g. from archives created with certain software on
  Windows) are normalized to forward slashes.

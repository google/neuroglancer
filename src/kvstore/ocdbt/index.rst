.. _ocdbt-kvstore:

ocdbt: Optionally-Cooperative Distributed B+tree
================================================

The OCDBT :ref:`key-value store adapter<kvstore-adapters>` provides access to an
:ref:`OCDBT database<tensorstore:ocdbt-kvstore-driver>`.

URL syntax
----------

- :file:`{base-kvstore-url/}|ocdbt:{path}/{to}/{entry}`
- :file:`{base-kvstore-url/}|ocdbt:@{TIMESTAMP}/{path}/{to}/{entry}`
- :file:`{base-kvstore-url/}|ocdbt:@v{N}/{path}/{to}/{entry}`

The :file:`{base-kvstore-url/}` must refer to a directory.

- The :file:`ocdbt:{path}/{to}/{entry}` syntax indicates the latest version.

- The :file:`ocdbt:@{TIMESTAMP}/{path}/{to}/{entry}` syntax specifies a version by commit
  timestamp. The timestamp must be in `ISO 8601
  <https://en.wikipedia.org/wiki/ISO_8601>`__ syntax
  :file:`{YYYY}-{MM}-{DD}T{hh}:{mm}:{ss}Z` or
  :file:`{YYYY}-{MM}-{DD}T{hh}:{mm}:{ss}.{sssssssss}Z`.

- The :file:`ocdbt:@v{N}/{path}/{to}/{entry}` syntax specifies a version by
  generation number.

For example:

- ``gs://bucket/path/to/repo.zarr.ocdbt/|ocdbt:path/to/array/``
- ``gs://bucket/path/to/repo.zarr.ocdbt/|ocdbt:@2024-12-31T10:23:45.123456789Z/path/to/array/``
- ``gs://bucket/path/to/repo.zarr.ocdbt/|ocdbt:@v10/path/to/array/``

.. note::

   Consistent with normal URL syntax, any special characters in the
   :file:`{path}/{to}/{entry}`, including ``@`` which is used to specify a
   version, must be `percent-encoded
   <https://en.wikipedia.org/wiki/Percent-encoding>`__.

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported.
   * - :ref:`kvstore-listing`
     - Supported.

.. list-table:: Required capabilities of base key-value store

   * - :ref:`kvstore-byte-range-reads`
     - Required.
   * - :ref:`kvstore-listing`
     - Not needed.

Auto detection
--------------

Directories containing OCDBT databases are detected automatically based on the
presence of the :file:`manifest.ocdbt` file.

Limitations
-----------

- Entries without a valid Unicode path are ignored.

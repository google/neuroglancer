.. _icechunk-kvstore:

Icechunk
========

The Icechunk :ref:`key-value store adapter<kvstore-adapters>` provides access to
an `Icechunk repository <https://icechunk.io/>`__ containing a :ref:`Zarr
v3<zarr-datasource>` hierarchy.

URL syntax
----------

- :file:`{base-kvstore-url/}|icechunk:{path/to/array/}`
- :file:`{base-kvstore-url/}|icechunk:@branch.{BRANCH}/{path/to/array/}`
- :file:`{base-kvstore-url/}|icechunk:@tag.{TAG}/{path/to/array/}`
- :file:`{base-kvstore-url/}|icechunk:@{SNAPSHOT}/{path/to/array/}`

The :file:`{base-kvstore-url/}` must refer to a directory.

- The :file:`icechunk:{path/to/array/}` syntax is equivalent to
  :file:`icechunk:@branch.main/{path/to/array/}`.

- The :file:`icechunk:@branch.{BRANCH}/{path/to/array/}` syntax indicates the
  latest version of the specified :file:`{BRANCH}`.

- The :file:`icechunk:@tag.{TAG}/{path/to/array/}` syntax indicates a specific
  tag.

- The :file:`icechunk:@{SNAPSHOT}/{path/to/array/}` syntax indicates a specific
  snapshot.

Currently, icechunk can only store Zarr v3 hierarchies. Therefore, it is always
used in conjunction with the :ref:`Zarr data format driver<zarr-datasource>`.

For example:

- ``gs://bucket/path/to/repo.zarr.icechunk/|icechunk:|zarr3:path/to/array/``
- ``gs://bucket/path/to/repo.zarr.icechunk/|icechunk:@branch.other/|zarr3:path/to/array/``
- ``gs://bucket/path/to/repo.zarr.icechunk/|icechunk:@tag.v5/|zarr3:path/to/array/``
- ``gs://bucket/path/to/repo.zarr.icechunk/|icechunk:@4N0217AZA4VNPYD0HR0G/|zarr3:path/to/array/``

.. note::

   Consistent with normal URL syntax, any special characters in the
   :file:`{path}/{to}/{array/}`, including ``@`` which is used to specify a ref,
   must be `percent-encoded <https://en.wikipedia.org/wiki/Percent-encoding>`__.

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
     - Required when a tag or snapshot is not specified explicitly.

Auto detection
--------------

Directories containing Icechunk repositories are detected automatically based on
the presence of the :file:`refs` and :file:`snapshots` sub-directories, and by
the presence of the :file:`refs/branch.main/ZZZZZZZZ.json` file.

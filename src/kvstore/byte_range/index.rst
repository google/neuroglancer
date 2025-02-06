.. _byte-range-kvstore:

Byte range
==========

The byte range :ref:`key-value store adapter<kvstore-adapters>` allows an
individual byte range within a file to be specified.

URL syntax
----------

- :file:`{base-kvstore-url}|byte-range:{start}-{end}`

The :file:`{base-kvstore-url}` must refer to a file. The :file:`{start}` bound
is inclusive, while the :file:`{end}` bound is exclusive; the total length is
``end - start``.

For example:

- ``gs://bucket/path/to/data|byte-range:1000-2000``

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported.
   * - :ref:`kvstore-listing`
     - Not applicable.

.. list-table:: Required capabilities of base key-value store

   * - :ref:`kvstore-byte-range-reads`
     - Required.
   * - :ref:`kvstore-listing`
     - Not needed.

.. _data-sources:

Data sources
============

Neuroglancer does not depend on any specific server backend for data access.
Instead, the Neuroglancer client application can access a large number of
different data formats and data API services directly from the browser.

All data sources are specified using a URL syntax.

.. _data-formats:

Data formats
------------

Neuroglancer supports the following file- and directory-based data formats
accessible from any of the supported :ref:`key-value stores<kvstores>`.

.. toctree::
   :maxdepth: 1

   zarr/index
   n5/index
   precomputed/index
   nifti/index
   deepzoom/index

.. _kvstores:

Key-value stores
----------------

Neuroglancer accesses all `file-based data formats<data-formats>` through
key-value store drivers, which provide a filesystem-like abstraction for reading
files and directories.

.. _kvstore-url:

URL syntax
~~~~~~~~~~

Key-value stores are specified using a *URL pipeline* syntax consisting of
``|``-delimited sequence of a :ref:`root key-value store URL<root-kvstores>`
followed by zero or more :ref:`adapter URLs<kvstore-adapters>`.

Examples:

- :file:`https://{host}/{path}` (:ref:`HTTP kvstore<http-kvstore>`, for
  accessing a file served by an HTTP server)
- :file:`s3://{bucket}/{path}` (:ref:`S3 kvstore<s3-kvstore>`, for
  accessing a file on S3)
- :file:`s3://{bucket}/{path}.zip|zip:path/within/zipfile.nii` (
  :ref:`S3 kvstore<s3-kvstore>` with :ref:`zip kvstore<zip-kvstore>` adapter,
  for accessing a file within a zipfile on S3)
-
  :file:`s3://{bucket}/{path}.zip|zip:inner/zipfile.zip|zip:path/in/nested/inner/zipfile.nii`
  (:ref:`S3 kvstore<s3-kvstore>` with :ref:`zip kvstore<zip-kvstore>` adapter
  applied twice, for accessing a file within a zipfile within a zipfile on S3)

.. _root-kvstores:

Root stores
~~~~~~~~~~~

Root key-value stores directly access a storage mechanism.

.. toctree::
   :maxdepth: 1

   http/index
   gcs/index
   s3/index

.. _kvstore-adapters:

Adapters
~~~~~~~~

Adapters transform some *base* key-value store to present a new key-value store
view, where the *base* key-value store is defined by a :ref:`root
kvstore<root-kvstores>` with zero or more other
:ref:`adapters<kvstore-adapters>` applied to it.

.. toctree::
   :maxdepth: 1

   zip/index
   ocdbt/index
   icechunk/index
   gzip/index
   byte_range/index

.. _kvstore-capabilities:

Capabilities
~~~~~~~~~~~~

Neuroglancer relies on a number of different *capabilities* provided by
key-value stores. The documentation for each key-value store details the
specific conditions under which each of these capabilities is supported.

.. _kvstore-byte-range-reads:

Byte range reads
  Reading just a specific range of bytes, indicated by an offset and a length,
  rather than an entire file. In some cases, only *prefix* reads, where the byte
  offset is ``0``, are supported.

  This is required to access various data formats, and for file-format
  auto-detection.

.. _kvstore-listing:

Key listing
  Listing of keys under a given prefix.

  This is required for interactive completion of URLs, and for accessing certain
  data formats.

.. _data-services:

Data services
-------------

.. toctree::
   :maxdepth: 1

   boss/index
   dvid/index
   render/index

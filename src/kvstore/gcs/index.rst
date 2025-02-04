.. _gcs-kvstore:

Google Cloud Storage
====================

The Google Cloud Storage key-value store is a `root key-value
store<root-kvstores>` for accessing Google Cloud Storage buckets.

URL syntax
----------

- :file:`gs://{bucket}/{path}`
- :file:`gs+ngauth+http://{nguath-host}/{bucket}/{path}`
- :file:`gs+ngauth+https://{nguath-host}/{bucket}/{path}`

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported
   * - :ref:`kvstore-listing`
     - Supported with ``storage.objects.list`` permission.

Authentication
--------------

When not using the :ref:`Python API<python-api>`:

- The :file:`gs://{bucket}/{path}` syntax implies anonymous access, meaning the
  :file:`{bucket}` must allow public read access without `requester pays
  <https://cloud.google.com/storage/docs/requester-pays>`__. Refer to the GCS
  documentation for `details on making buckets publicly accessible
  <https://cloud.google.com/storage/docs/access-control/making-data-public#buckets>`__.
- To access private buckets, the
  :file:`gs+ngauth+http://{nguath-host}/{bucket}/{path}` syntax may be used to
  authenticate using credentials obtained from an `ngauth
  server <https://github.com/google/neuroglancer/blob/master/ngauth_server/README.md>`__.

When using the :ref:`Python API<python-api>` with credentials enabled:

- The :file:`gs://{bucket}/{path}` syntax uses the `Google Application Default
  Credentials
  <https://google-auth.readthedocs.io/en/latest/reference/google.auth.html>`__,
  if available.
- The :file:`gs+ngauth+http://{nguath-host}/{bucket}/{path}` behaves the same as
  :file:`gs://{bucket}/{path}` and also uses the Google Application Default
  Credentials.  The specified :file:`{ngauth-server}` is not used.

Another method for keeping data private while still allowing Neuroglancer to
access it without the need for an ``ngauth`` server is to include a long, random
string as a suffix of the bucket name, such that the bucket name itself serves
as a `capability URL <https://www.w3.org/2001/tag/doc/capability-urls/>`__.

Required permissions
--------------------

- The ``storage.objects.get`` permission is required for reading.
- Additionally, the ``storage.objects.list`` permission is required for listing
  directories.

CORS
----

Neuroglancer uses the Google Cloud Storage JSON API, which does not require any
CORS configuration on the bucket.

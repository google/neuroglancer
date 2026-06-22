.. _s3-kvstore:

S3
==

The S3 key-value store is a :ref:`root key-value store<root-kvstores>` for
accessing S3 buckets hosted by Amazon as well as other S3-compatible servers.

URL syntax
----------

- :file:`s3://{bucket}/{path}`

  Specifies an Amazon S3 bucket (with the endpoint
  :file:`{bucket}.s3.amazonaws.com`).

- :file:`s3+http{s}://{host}/{path}` or :file:`s3+http{s}://{host}/{bucket}/{path}`

  Specifies an S3-compatible server at :file:`http://{host}` or
  :file:`https://{host}`.

  .. note::

     This URL syntax can ambiguously specify either:

     - a virtual hosted-style URL :file:`s3+https://{host}/{path}`, where
       :file:`https://{host}` refers to a single bucket, or
     - a path-style URL :file:`s3+https://{host}/{bucket}/{path}`, where the
       :file:`{bucket}` is specified as the first component of the path.

     Neuroglancer automatically detects which of these cases applies.

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported
   * - :ref:`kvstore-listing`
     - Supported with ``s3:ListBucket`` permission.

Authentication
--------------

Currently, only anonymous access is supported.

CORS
----

If the Neuroglancer client itself is not hosted in the same S3 bucket, the
bucket must be configured with a `CORS policy
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html>`__
such as the following:

.. code-block:: json

   [
       {
           "AllowedHeaders": [
               "*"
           ],
           "AllowedOrigins": [
               "*"
           ],
           "ExposeHeaders": [
               "ETag",
               "Content-Range",
               "Content-Encoding",
               "Content-Length"
           ],
           "MaxAgeSeconds": 3000
       }
   ]

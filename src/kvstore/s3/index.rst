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

When not using the :ref:`Python API<python-api>`:

- The :file:`s3://{bucket}/{path}` syntax implies anonymous access, meaning the
  :file:`{bucket}` must allow public read access without `requester pays
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html>`__. Refer to the AWS
  documentation for `details on making buckets publicly accessible
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-management.html>`__.

When using the :ref:`Python API<python-api>` with credentials enabled:

- The :file:`s3://{bucket}/{path}` syntax uses the `AWS Default
  Credentials
  <https://boto3.amazonaws.com/v1/documentation/api/latest/guide/credentials.html>`__,
  if available.


Required permissions
--------------------

- The ``s3:GetObject`` permission is required for reading.
- Additionally, the ``s3:ListBucket`` permission is required for listing
  directories.

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

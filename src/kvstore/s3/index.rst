.. _s3-kvstore:

Amazon S3
=========

The Amazon S3 key-value store is a :ref:`root key-value store<root-kvstores>` for accessing S3 buckets.

URL syntax
----------

- :file:`s3://{bucket}/{path}`

.. list-table:: Capabilities

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
               "*"
           ],
           "MaxAgeSeconds": 3000
       }
   ]

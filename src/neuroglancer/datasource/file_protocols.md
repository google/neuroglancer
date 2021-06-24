File-backed data sources, which include [precomputed](./precomputed), [zarr](./zarr), [n5](./n5), and
[nifti](./nifiti), support the following URL protocols for accessing file data:

- `http://` and `https://`: unathenticated HTTP access via normal `GET` requests.

  Neuroglancer supports interactive completion of data source URLs if the web server provides HTML
  directory listings.

  Note that because of [mixed content
  blocking](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content) in Chrome and
  Firefox, if the Neuroglancer client itself is served from an `https://` URL
  (e.g. `https://neuroglancer-demo.appspot.com`), Neuroglancer cannot access data sources using
  `http://` URLs, only `https://`) URLs are allowed.  However, data sources served from
  `http://127.0.0.1[:PORT]` (on Chrome and Firefox) and `http://localhost[:PORT]` (on Chrome) are
  allowed by exceptions to the normal mixed content blocking.

  If the Neuroglancer client is served from an `http://` URL, data sources served from both
  `http://` and `https://` URLs are supported.

  If the data source is served from a different
  [origin](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy) than the
  Neuroglancer client itself, then the server hosting the data must allow
  [cross-origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) requests.  The web server
  must be configured to send an appropriate `Access-Control-Allow-Origin` header.

- `gs://BUCKET/PATH`: access to Google Cloud Storage (GCS) buckets

  - When not using the Python integration, Neuroglancer can only access buckets that allow public read
    access and do not require [requester pays](https://cloud.google.com/storage/docs/requester-pays).

    Specifically, the bucket must grant `storage.objects.get` permission to `allUsers`, which you
    can enable using [these instructions](
    https://cloud.google.com/storage/docs/access-control/making-data-public#buckets).

    If `storage.objects.list` permission is also granted to `allUsers`, Neuroglancer supports
    interactive completion of data source URLs.

    To access non-public buckets, you can use an `ngauth` server, described below.

    Another method for keeping data private while still allowing Neuroglancer to access it without the
    need for an `ngauth` server is to include a long, random string as a suffix of the bucket name,
    such that the bucket name itself serves as the secret key.

  - When using the Python integration, Neuroglancer *can* access non-public buckets without
    `ngauth`, using [Application Default
    Credentials](https://google-auth.readthedocs.io/en/latest/reference/google.auth.html) provided
    by the Neuroglancer Python library.

  The `gs://` protocol uses the Google Cloud Storage [JSON
  API](https://cloud.google.com/storage/docs/json_api), which never receives stale data even if
  [caching is enabled](https://cloud.google.com/storage/docs/metadata#cache-control), and does not
  require that you configure a [CORS
  policy](https://cloud.google.com/storage/docs/configuring-cors).  To take advantage of HTTP
  caching (which may provide slightly better performance), you can use the [S3-compatible XML
  API](https://cloud.google.com/storage/docs/xml-api/overview) using the `gs+xml://` protocol, as
  described below.

- `gs+xml://BUCKET/PATH`: access to Google Cloud Storage (GCS) buckets using the [S3-compatible XML
  API](https://cloud.google.com/storage/docs/xml-api/overview).

  Differs from `gs://` in that cached (and possibly stale) data may be received if [caching is
  enabled](https://cloud.google.com/storage/docs/metadata#cache-control).  You must configure a
  [CORS policy](https://cloud.google.com/storage/docs/configuring-cors), such as the following:

  ```json
  [{"maxAgeSeconds": 3600, "method": ["GET"], "origin": ["*"], "responseHeader": ["Content-Type", "Range"]}]
  ```

- `gs+ngauth+http://NGAUTH_SERVER/BUCKET/PATH` and `gs+ngauth+https://NGAUTH_SERVER/BUCKET/PATH`:
  access to non-public Google Cloud Storage (GCS) buckets via an [ngauth
  server](../../../ngauth_server).

  This protocol uses the the Google Cloud Storage [JSON
  API](https://cloud.google.com/storage/docs/json_api).  To use the XML API instead, you can use
  `gs+xml+ngauth+http://` or `gs+xml+ngauth+https://`.

  The first time you use a given ngauth server, a status message at the bottom of the browser window
  will prompt you to log in.  Once you log in with your Google account using Google Sign In, you can
  access buckets that both your user account and the ngauth server has permission to access.

  Refer to the [ngauth server](../../../ngauth_server) documentation for details.

  When using the Python integration, the `NGAUTH_SERVER` is ignored and credentials are provided by
  the Neuroglancer Python library instead, as for the `gs://` protocol.

- `gs+ngauth+http://NGAUTH_SERVER/BUCKET/PATH` and `gs+ngauth+https://NGAUTH_SERVER/BUCKET/PATH`:
  access to non-public Google Cloud Storage (GCS) buckets via an [ngauth
  server](../../../ngauth_server) using the [S3-compatible XML
  API](https://cloud.google.com/storage/docs/xml-api/overview).

- `s3://BUCKET/PATH`: access to public Amazon Simple Storage Service (S3) buckets.

  Only buckets that allow public read access and do not require [requester
  pays](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html) are
  supported.

  Additionally, you must configure a suitable [CORS
  configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html).

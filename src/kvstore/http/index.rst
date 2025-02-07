.. _http-kvstore:

HTTP
====

The HTTP key-value store is a :ref:`root key-value store<root-kvstores>` for
accessing regular HTTP servers.

URL syntax
----------

- :file:`http://{host}/{path}`
- :file:`https://{host}/{path}`
- :file:`https://{host}/{path}?{query}`

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported if the server supports `HTTP range requests
       <https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests>`__.
   * - :ref:`kvstore-listing`
     - Supported if the server supports:

       - traditional HTML directory listings in response to
         :file:`https://{host}/{path}/` GET requests, or
       - S3-compatible bucket listing.

CORS
----

If the HTTP URL refers to a different `origin
<https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy>`__
than that from which the Neuroglancer client itself is hosted, the specified
:file:`{host}` must be configured to allow `cross-origin
<https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS>`__ requests.

The recommended CORS headers are:

- ``access-control-allow-origin: *``
- ``access-control-expose-headers: *``

Alternatively, more specific CORS headers may be used:

- ``access-control-allow-origin: https://{neuroglancer-host}``
- ``access-control-expose-headers: content-range, content-encoding``

.. warning::

   CORS headers can allow malicious websites to access data on servers that are
   accessible to the public internet, including servers listening only on
   localhost. Any private data should be protected by appropriate access control
   mechanisms such as `capability URLs
   <https://www.w3.org/2001/tag/doc/capability-urls/>`__.

:file:`http://` access from :file:`https://` origin
---------------------------------------------------

Note that because of `mixed content blocking
<https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content>`__ in
modern browsers, if the Neuroglancer client itself is served from an
:file:`https://` origin (e.g. :file:`https://neuroglancer-demo.appspot.com`),
Neuroglancer cannot access data sources using :file:`http://` URLs, only
:file:`https://`) URLs are allowed. However, data sources served from
:file:`http://127.0.0.1[:PORT]` (on Chrome and Firefox) and
:file:`http://localhost[:PORT]` (on Chrome) are allowed by exceptions to the
normal mixed content blocking.

If the Neuroglancer client is served from an :file:`http://` origin, data sources
served from both :file:`http://` and :file:`https://` URLs are supported.

Query parameters
----------------

If the server requires query parameters (e.g. an access token), they may be
specified as :file:`https://{host}/{path}?{query}`.

.. note::

   When query parameters are specified for a directory, e.g.
   :file:`https://{host}/dataset.zarr/?{query}`, they will also be used for all
   files accessed within that directory.

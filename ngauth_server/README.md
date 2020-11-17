ngauth
======

ngauth is a lightweight server that allows Neuroglancer to access non-public Google Cloud Storage
(GCS) buckets.

Within Neuroglancer, you can use `gs+ngauth+https://SERVER/BUCKET/PATH` to access `gs://BUCKET/PATH`
using the ngauth server `https://SERVER`.  For example, if ngauth is deployed to Google App Engine
under the `NGAUTH_PROJECT_ID` project, you can use:
`gs+ngauth+https://NGAUTH_PROJECT_ID.appspot.com/BUCKET/PATH`.  This URL scheme is supported by all
file-backed data sources, including Neuroglancer precomputed, n5, zarr, nifiti, vtk, and obj.  For
example, to access a Neuroglancer precomputed datasource via ngauth, use:

`precomputed://gs+ngauth+https://NGAUTH_PROJECT_ID.appspot.com/BUCKET/PATH`

If you have not already logged into the ngauth server, Neuroglancer will prompt you to login using
Google Sign In.  You will remain logged in for 1 year.

To login or logout, you can also directly visit the ngauth server in a web browser:
`https://NGAUTH_PROJECT_ID.appspot.com`

Note that when using the Python integration, both regular `gs` and `gs+ngauth+{http,https}` URLs may
be used to access non-public GCS buckets, using credentials provided by Python.  The ngauth server,
if specified, is ignored.

Method of operation
-------------------

ngauth can be run on any server, but it is intended to run on Google App Engine (GAE) using a
dedicated Google Cloud project, and that is likely to be the most convenient option.

Users authenticate to ngauth using Google Sign In, and then may request an access token for a
particular bucket.  ngauth validates that the origin of the request is allowed, and uses the
[iam.troubleshoot](https://cloud.google.com/iam/docs/troubleshooting-access) API to check whether a
user has read access.  If it can determine that the user has access, it returns a [bounded,
short-lived access
token](https://cloud.google.com/iam/docs/downscoping-short-lived-credentials?hl=en#create-credential)
that can be used to read from the bucket.

ngauth requires minimal resources because it only handles access tokens.  It does not handle any of
the actual data transfer from the bucket.

Limitations
-----------

ngauth relies on the `iam.troubleshoot` API to determine whether a user has read access to a bucket.
For security reasons, the `iam.troubleshoot` API is limited in what it can resolve by the
permissions of the service account used by ngauth is running.  If the service account does not have
sufficient permissions, ngauth may fail to grant a user access even if the user actually does have
access through a policy not visible to ngauth.

In particular:

- To resolve bucket-level IAM policies, the service account used by ngauth must have
  `storage.buckets.getIamPolicy` permission on the bucket.

- To resolve project-level IAM policies, the service account used by ngauth must have
  `resourcemanager.projects.getIamPolicy` permission on the project.

- In most cases it is *not* possible for ngauth to resolve permissions granted to a user indirectly
  via group membership.  Instead, users must be listed directly in the bucket or project IAM policy.

Note that even if ngauth is unable to resolve all relevant permissions, it will never grant access
to a user that does not actually have read access to the bucket, i.e. false positives are not
possible.

Granting permissions
--------------------

To make a non-public GCS bucket accessible to a Neuroglancer user through ngauth, you must grant the
following permissions:

1. The user's Google account must have `storage.objects.get` permission (e.g. via the
   storage.objectViewer role) for the bucket or project.  As described in the Limitations section
   above, this permission must be granted in a way that is visible to ngauth.

2. The service account used by ngauth must have `storage.objects.get` permission (and optionally
   `storage.objects.list` permission if you wish to allow listing) for the bucket or project, as
   well as the permissions necessary to read any relevant IAM policies, as described in the
   Limitations section above.  The simplest way to grant these permissions for a particular bucket
   is via the `roles/storage.objectViewer` and `roles/iam.securityReviewer` roles:

   ```shell
   gsutil iam ch serviceAccount:NGAUTH_PROJECT_ID@appspot.gserviceaccount.com:roles/storage.objectViewer,roles/iam.securityReviewer gs://YOUR_BUCKET
   ```

   The `roles/storage.objectViewer` role grants read and list access to the bucket and the
   `roles/iam.securityReviewer` role grants access to read IAM policies.

   To grant these permissions project-wide:

   ```shell
   gcloud projects add-iam-policy-binding OTHER_PROJECT_ID \
     --member=serviceAccount:NGAUTH_PROJECT_ID@appspot.gserviceaccount.com \
     --role=roles/storage.objectViewer,roles/iam.securityReviewer
   ```

   If you only grant bucket-level `roles/iam.securityReviewer` access to the ngauth service account,
   you must grant users access at the bucket level as well.  ngauth will not be able to determine
   that users have project-level access.  To determine that users have project-level access to a
   bucket, ngauth must have project-level `roles/iam.securityReviewer` access.

   Note that IAM changes can take up to 7 minutes to take effect.


A single ngauth server may be used with any number of GCS buckets in any number of GCS projects.
However, since the service account used by ngauth must have read access to any bucket with which it
can be used, it may be desirable to run separate ngauth servers to avoid granting broad access to a
single ngauth server administrator.

Setup
-----

The ngauth server must be provided with a Google Cloud service account, which is located using the
"Application Default Credentials" mechanism
(https://godoc.org/golang.org/x/oauth2/google#FindDefaultCredentials).  If running on Google App
Engine, this service account is `YOUR_PROJECT_ID@appspot.gserviceaccount.com`.  You should ensure
that this service account is not used for any other purpose, or you may inadvertently grant
Neuroglancer access to data you do not intend.

1. Create a new dedicated Google Cloud Project.

   https://console.developers.google.com/projectcreate

   For convenience, if you are using [direnv](https://direnv.net/), you can create an `.envrc` file
   containing:

   ```shell
   export CLOUDSDK_CORE_PROJECT=YOUR_PROJECT_ID
   ```

   If you do that, you can skip the `--project YOUR_PROJECT_ID` arguments in the commands below.

2. Create the `secrets` sub-directory for storing the configuration data.

  ```shell
  mkdir secrets
  ```

3. Create a new Google OAuth2 client id and secret following these instructions:
   https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred

   For the OAuth consent screen registration, include under "non-sensitive scopes"
   `.../auth/userinfo.email`.

   You don't need to add any "Test users".

   After you complete the OAuth consent screen registration, click "Publish App".

   Under "Authorized redirect URIs", include `http://localhost:8080/auth_redirect` for development
   purposes and `https://YOUR_PROJECT_ID.appspot.com/auth_redirect` for production use (assuming you
   are deploying to Google App Engine).  If you wish to deploy ngauth to a different host, be sure
   to include `https://HOSTNAME/auth_redirect` in the list.

   Download the client credentials as JSON and save to `secrets/client_credentials.json`.

   Because ngauth does not request any sensitive scopes, verification of your OAuth consent screen
   is not necessary.

4. Generate new random HMAC key for authenticating user login sessions:

   ```shell
   dd if=/dev/urandom of=secrets/login_session_key.dat bs=1 count=32
   ```

   **WARNING**: This key is used by the ngauth server to authenticate logged-in users.  Anyone with
   access to this key can spoof ngauth user login tokens to obtain `roles/storage.objectViewer`
   access to any bucket accessible to the ngauth service account.

5. Specify the allowed Neuroglancer client
   [origins](https://developer.mozilla.org/en-US/docs/Glossary/Origin) by creating
   `secrets/allowed_origins.txt`.

   The contents should be a single line containing a regular expression
   (https://golang.org/s/re2syntax) that matches allowed origins.  For example:

   ```
   ^((http://localhost(|:[0-9]+))|(https://neuroglancer-demo\.appspot\.com))$
   ```

   allows any localhost origin as well as `https://neuroglancer-demo.appspot.com`.

   **WARNING** This allowed origins pattern is the **ONLY** security measure that prevents arbitrary
   websites you visit from reading GCS buckets that are accessible to you through ngauth.  You
   should take extraordinary care when writing this regular expression to avoid inadvertently
   allowing additional origins.  In particular, make sure to anchor the pattern with `^` and `$` and
   to escape using `\.` any literal dots in hostnames.

6. Install the Google Cloud SDK if not already installed:

  https://cloud.google.com/sdk/docs/install

  After installing, set up gcloud credentials and Application Default Credentials:

  ```shell
  gcloud auth login
  gcloud auth application-default login
  ```

7. Enable the `policytroubleshooter` API on the project:

  ```shell
  gcloud services enable policytroubleshooter.googleapis.com --project YOUR_PROJECT_ID
  ```

8. Create an App Engine application for the project.

  ```shell
  gcloud app create --project YOUR_PROJECT_ID
  ```

  This command prompts you to select a region.  `us-central` is normally a good choice.  Note that
  you *cannot* change the region later.

Deployment to Google App Engine
-------------------------------

After completing the setup step, you can deploy to Google App Engine:

```shell
gcloud app deploy --project YOUR_PROJECT_ID
```

Local deployment
----------------

To run ngauth locally using the same service account as Google App Engine:

1. Grant your user account permission to impersonate the Google App Engine service account:

   ```shell
   gcloud iam service-accounts add-iam-policy-binding NGAUTH_PROJECT_ID@appspot.gserviceaccount.com \
     --member=user:YOUR_GOOGLE_ACCOUNT_EMAIL \
     --role=roles/iam.serviceAccountTokenCreator
   ```

   Note that IAM changes can take up to 7 minutes to take effect.

2. Set the `IMPERSONATE_SERVICE_ACCOUNT` environment variable (you may want to set this in an
   `.envrc` file if you are using [direnv](https://direnv.net/)):

   ```shell
   export IMPERSONATE_SERVICE_ACCOUNT=NGAUTH_PROJECT_ID@appspot.gserviceaccount.com
   ```

   Alternatively, you can set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to a local
   file containing the Google service account credentials to use.

3. Install Golang, either using your operating system's package manager or from these instructions:

   https://golang.org/doc/install

4. Build and run the server:

   ```shell
   go run .
   ```

   You can use the `PORT` environment variable to use an alternate port, but make sure to include
   `http://localhost:PORT/auth_redirect` in the OAuth2 client's list of Authorized Redirect URIs.

Background
----------

The GCS user authentication model does not support web applications like Neuroglancer without
requiring users to grant overly broad permissions to the application, which would be a poor security
practice.  In particular, it is not possible for a user to grant an application read access just to
a particular bucket; the user can only grant read access to all buckets to which the user has
access.  For that reason, Neuroglancer does not directly access non-public GCS buckets.

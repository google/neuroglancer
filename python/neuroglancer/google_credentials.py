# @license
# Copyright 2017 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import absolute_import

import concurrent.futures
import logging
import threading

from . import credentials_provider
from .futures import run_on_new_thread


class GoogleOAuth2FlowCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self, scopes, client_id, client_secret):
        super(GoogleOAuth2FlowCredentialsProvider, self).__init__()
        self.scopes = scopes
        self.client_id = client_id
        self.client_secret = client_secret

        # Make sure logging is initialized.  Does nothing if logging has already
        # been initialized.
        logging.basicConfig()

    def get_new(self):
        def func():
            import apitools.base.py.credentials_lib
            result = apitools.base.py.credentials_lib.GetCredentials(
                package_name='',
                scopes=self.scopes,
                client_id=self.client_id,
                client_secret=self.client_secret,
                user_agent=u'python-neuroglancer',
            )
            return dict(tokenType=u'Bearer', accessToken=result.get_access_token().access_token)

        return run_on_new_thread(func)


class GoogleApplicationDefaultCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self):
        super(GoogleApplicationDefaultCredentialsProvider, self).__init__()

        # Make sure logging is initialized.  Does nothing if logging has already
        # been initialized.
        logging.basicConfig()

        self._lock = threading.Lock()
        self._credentials = None

    def get_new(self):
        def func():
            with self._lock:
                if self._credentials is None:
                    import google.auth
                    credentials, project = google.auth.default()
                    del project
                    self._credentials = credentials
                if not self._credentials.valid:
                    import google.auth.transport.requests
                    import requests
                    request = google.auth.transport.requests.Request()
                    self._credentials.refresh(request)
                return dict(tokenType=u'Bearer', accessToken=self._credentials.token)

        return run_on_new_thread(func)


_global_google_application_default_credentials_provider = None
_global_google_application_default_credentials_provider_lock = threading.Lock()


def get_google_application_default_credentials_provider():
    global _global_google_application_default_credentials_provider
    with _global_google_application_default_credentials_provider_lock:
        if _global_google_application_default_credentials_provider is None:
            _global_google_application_default_credentials_provider = GoogleApplicationDefaultCredentialsProvider(
            )
        return _global_google_application_default_credentials_provider

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


class GoogleCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self, scopes, client_id, client_secret):
        super(GoogleCredentialsProvider, self).__init__()
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

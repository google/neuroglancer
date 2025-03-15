# @license
# Copyright 2025 Google Inc.
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


import logging
import threading

from . import credentials_provider
from .futures import run_on_new_thread


class AWSApplicationDefaultCredentialsProvider(
    credentials_provider.CredentialsProvider
):
    def __init__(self):
        super().__init__()

        # Make sure logging is initialized.  Does nothing if logging has already
        # been initialized.
        logging.basicConfig()

        self._lock = threading.Lock()
        self._credentials = None

    def get_new(self):
        def func():
            with self._lock:
                if self._credentials is None:
                    import boto3
                    
                    session = boto3.session.Session()
                    credentials = session.get_credentials()
                    self._credentials = credentials
                
                # Will automatically refresh if possible
                frozen_credentials = self._credentials.get_frozen_credentials()
                return dict(
                    accessKeyId=frozen_credentials.access_key,
                    secretAccessKey=frozen_credentials.secret_key,
                    token=frozen_credentials.token,
                    region=session.region_name
                )

        return run_on_new_thread(func)


_global_aws_application_default_credentials_provider = None
_global_aws_application_default_credentials_provider_lock = threading.Lock()


def get_aws_application_default_credentials_provider():
    global _global_aws_application_default_credentials_provider
    with _global_aws_application_default_credentials_provider_lock:
        if _global_aws_application_default_credentials_provider is None:
            _global_aws_application_default_credentials_provider = (
                AWSApplicationDefaultCredentialsProvider()
            )
        return _global_aws_application_default_credentials_provider

# @license
# Copyright 2021 Google Inc.
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

"""Module implements function for authentication of layers based on DVID.
    Here tokens are fetched from local locations like env vars etc."""

from __future__ import absolute_import

import logging
import os

from . import credentials_provider
from .futures import run_on_new_thread


class TokenbasedDefaultCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self, parameters):
        super(TokenbasedDefaultCredentialsProvider, self).__init__()

        # Make sure logging is initialized.
        # Does nothing if logging has already been initialized.
        logging.basicConfig()
        self.parameters = parameters
        self._credentials = {}

    def get_new(self):
        def func():
            try:
                credentials = os.environ['DVID_CREDENTIALS']
                credentials = dict(item.split("=") for item in credentials.split(","))
                token = credentials[self.parameters['dvidServer']]
            except KeyError:
                raise RuntimeError(
                    """DVID_CREDENTIALS is not defined in your environment or does
                    not contain the token for the server: """ +
                    self.parameters['dvidServer'])
            self._credentials['token'] = token
            return dict(tokenType=u'Bearer', accessToken=self._credentials['token'])

        return run_on_new_thread(func)


_global_tokenbased_application_default_credentials_provider = None


def get_tokenbased_application_default_credentials_provider(parameters):
    global _global_tokenbased_application_default_credentials_provider
    if _global_tokenbased_application_default_credentials_provider is None:
        _global_tokenbased_application_default_credentials_provider =\
            TokenbasedDefaultCredentialsProvider(parameters)
    return _global_tokenbased_application_default_credentials_provider

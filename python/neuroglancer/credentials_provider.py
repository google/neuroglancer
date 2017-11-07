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
import threading

from .futures import future_then_immediate

class CredentialsManager(object):
    def __init__(self):
        self._providers = dict()

    def register(self, key, credentials_provider_getter):
        self._providers[key] = credentials_provider_getter

    def get(self, key, parameters):
        return self._providers[key](parameters)


class CredentialsProvider(object):
    next_generation = 0
    next_generation_lock = threading.Lock()

    def __init__(self):
        self.credentials = None
        self.future = None
        self._lock = threading.Lock()

    def get(self, invalid_generation=None):
        with self._lock:
            if self.future is not None and (self.credentials is None or
                                            invalid_generation != self.credentials['generation']):
                return self.future
            self.credentials = None

            def attach_generation_and_save_credentials(credentials):
                with self._lock:
                    with CredentialsProvider.next_generation_lock:
                        CredentialsProvider.next_generation += 1
                        next_generation = CredentialsProvider.next_generation
                    credentials_with_generation = dict(
                        credentials=credentials, generation=next_generation)
                    self.credentials = credentials_with_generation
                    return credentials_with_generation

            self.future = future_then_immediate(self.get_new(),
                                                attach_generation_and_save_credentials)
            return self.future

    def get_new(self):
        raise NotImplementedError

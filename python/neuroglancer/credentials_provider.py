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


class CredentialsManager(object):
    def __init__(self):
        self._providers = dict()

    def register(self, key, credentials_provider):
        self._providers[key] = credentials_provider

    def get(self, key):
        return self._providers.get(key)


class CredentialsProvider(object):
    def __init__(self):
        self.credentials = None
        self.future = None
        self.next_generation = 0
        self._lock = threading.Lock()

    def get(self, invalid_generation=None):
        if self.future is not None and (self.credentials is None or invalid_generation != self.credentials['generation']):
            return self.future
        self.credentials = None
        self.future = outer_future = concurrent.futures.Future()
        def on_done(f):
            try:
                credentials = f.result()
                with self._lock:
                    self.next_generation += 1
                    credentials_with_generation = dict(credentials=credentials, generation=self.next_generation)
                    self.credentials = credentials_with_generation
                outer_future.set_result(credentials_with_generation)
            except Exception as e:
                outer_future.set_exception(e)
        self.get_new().add_done_callback(on_done)
        return outer_future

    def get_new(self):
        raise NotImplementedError

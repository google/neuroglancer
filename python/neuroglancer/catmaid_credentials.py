# @license
# Copyright 2026 Google Inc.
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

import json
import urllib.request

from . import credentials_provider
from .futures import run_on_new_thread


class CatmaidAnonymousCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self, parameters):
        super().__init__()
        self.server_url = (parameters or {}).get("serverUrl", "")

    def get_new(self):
        server_url = self.server_url

        def func():
            token_url = f"{server_url}/accounts/anonymous-api-token"
            with urllib.request.urlopen(token_url) as response:
                data = json.loads(response.read().decode())
            if not isinstance(data, dict) or not isinstance(data.get("token"), str):
                raise RuntimeError(f"Unexpected response from {token_url}: {data!r}")
            return {"token": data["token"]}

        return run_on_new_thread(func)

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
import os
import threading
import urllib.request

from . import credentials_provider
from .futures import run_on_new_thread

_configured_tokens = {}
_providers = {}
_providers_lock = threading.Lock()


def canonicalize_server_url(server_url):
    if not isinstance(server_url, str) or not server_url:
        raise ValueError("CATMAID server URL must be a non-empty string")
    return server_url.rstrip("/")


def set_token(server_url, token):
    """Configure or remove a personal API token for one CATMAID server."""
    server_url = canonicalize_server_url(server_url)
    with _providers_lock:
        if token is None:
            _configured_tokens.pop(server_url, None)
            return
        if not isinstance(token, str) or not token.strip():
            raise ValueError("CATMAID API token must be a non-empty string or None")
        _configured_tokens[server_url] = token.strip()


def _get_environment_tokens():
    value = os.environ.get("CATMAID_CREDENTIALS")
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "CATMAID_CREDENTIALS must be a JSON object mapping server URLs to tokens"
        ) from error
    if not isinstance(parsed, dict) or any(
        not isinstance(server_url, str)
        or not isinstance(token, str)
        or not token.strip()
        for server_url, token in parsed.items()
    ):
        raise RuntimeError(
            "CATMAID_CREDENTIALS must be a JSON object mapping server URLs to "
            "non-empty string tokens"
        )
    return {
        canonicalize_server_url(server_url): token.strip()
        for server_url, token in parsed.items()
    }


def _get_configured_token(server_url):
    with _providers_lock:
        token = _configured_tokens.get(server_url)
    if token is not None:
        return token
    return _get_environment_tokens().get(server_url)


class CatmaidCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self, parameters):
        super().__init__()
        self.server_url = canonicalize_server_url(
            (parameters or {}).get("serverUrl", "")
        )
        self._last_personal_token = None
        self._anonymous_token_was_returned = False

    def get_new(self):
        server_url = self.server_url

        def func():
            personal_token = _get_configured_token(server_url)
            if personal_token is not None:
                if personal_token == self._last_personal_token:
                    raise RuntimeError(
                        f"The configured CATMAID API token for {server_url} was rejected"
                    )
                self._last_personal_token = personal_token
                return {"token": personal_token, "kind": "personal"}

            if self._anonymous_token_was_returned:
                raise RuntimeError(
                    f"CATMAID server {server_url} requires a personal API token; "
                    "call neuroglancer.set_catmaid_token or configure "
                    "CATMAID_CREDENTIALS"
                )

            token_url = f"{server_url}/accounts/anonymous-api-token"
            with urllib.request.urlopen(token_url) as response:
                data = json.loads(response.read().decode())
            if not isinstance(data, dict) or not isinstance(data.get("token"), str):
                raise RuntimeError(f"Unexpected response from {token_url}: {data!r}")
            self._anonymous_token_was_returned = True
            return {"token": data["token"], "kind": "anonymous"}

        return run_on_new_thread(func)


def get_credentials_provider(parameters):
    server_url = canonicalize_server_url((parameters or {}).get("serverUrl", ""))
    with _providers_lock:
        provider = _providers.get(server_url)
        if provider is None:
            provider = CatmaidCredentialsProvider({"serverUrl": server_url})
            _providers[server_url] = provider
        return provider

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

import io
import json
from unittest import mock

import pytest
from neuroglancer import catmaid_credentials


def get_credentials(provider, invalid_generation=None):
    return provider.get(invalid_generation).result(timeout=2)


def test_runtime_token_precedes_environment(monkeypatch):
    server_url = "https://runtime-token.catmaid.example"
    monkeypatch.setenv(
        "CATMAID_CREDENTIALS", json.dumps({server_url: "environment-token"})
    )
    catmaid_credentials.set_token(server_url + "/", " runtime-token ")
    try:
        provider = catmaid_credentials.CatmaidCredentialsProvider(
            {"serverUrl": server_url}
        )
        assert get_credentials(provider)["credentials"] == {
            "token": "runtime-token",
            "kind": "personal",
        }
    finally:
        catmaid_credentials.set_token(server_url, None)


def test_environment_token_is_normalized(monkeypatch):
    server_url = "https://environment-token.catmaid.example"
    monkeypatch.setenv(
        "CATMAID_CREDENTIALS",
        json.dumps({server_url + "/": " environment-token "}),
    )
    provider = catmaid_credentials.CatmaidCredentialsProvider(
        {"serverUrl": server_url + "/"}
    )

    assert get_credentials(provider)["credentials"] == {
        "token": "environment-token",
        "kind": "personal",
    }


def test_anonymous_token_is_used_without_configuration(monkeypatch):
    server_url = "https://anonymous.catmaid.example"
    monkeypatch.delenv("CATMAID_CREDENTIALS", raising=False)
    provider = catmaid_credentials.CatmaidCredentialsProvider(
        {"serverUrl": server_url + "/"}
    )
    response = io.BytesIO(json.dumps({"token": "anonymous-token"}).encode())

    with mock.patch(
        "neuroglancer.catmaid_credentials.urllib.request.urlopen",
        return_value=response,
    ) as urlopen:
        credentials = get_credentials(provider)

    assert credentials["credentials"] == {
        "token": "anonymous-token",
        "kind": "anonymous",
    }
    urlopen.assert_called_once_with(server_url + "/accounts/anonymous-api-token")

    with pytest.raises(RuntimeError, match="requires a personal API token"):
        get_credentials(provider, credentials["generation"])


def test_rejected_personal_token_requires_reconfiguration(monkeypatch):
    server_url = "https://rejected-token.catmaid.example"
    monkeypatch.setenv(
        "CATMAID_CREDENTIALS", json.dumps({server_url: "rejected-token"})
    )
    provider = catmaid_credentials.CatmaidCredentialsProvider({"serverUrl": server_url})
    credentials = get_credentials(provider)

    with pytest.raises(RuntimeError, match="was rejected"):
        get_credentials(provider, credentials["generation"])


def test_malformed_environment_configuration_is_rejected(monkeypatch):
    monkeypatch.setenv("CATMAID_CREDENTIALS", "[]")
    provider = catmaid_credentials.CatmaidCredentialsProvider(
        {"serverUrl": "https://invalid-config.catmaid.example"}
    )

    with pytest.raises(RuntimeError, match="must be a JSON object"):
        get_credentials(provider)


def test_provider_cache_is_scoped_by_canonical_server_url():
    first = catmaid_credentials.get_credentials_provider(
        {"serverUrl": "https://cached.catmaid.example/"}
    )
    second = catmaid_credentials.get_credentials_provider(
        {"serverUrl": "https://cached.catmaid.example"}
    )
    other = catmaid_credentials.get_credentials_provider(
        {"serverUrl": "https://other.catmaid.example"}
    )

    assert first is second
    assert first is not other

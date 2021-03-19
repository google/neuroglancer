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

from neuroglancer import url_state


def test_convert_string_literal():
    quote_initial = u'\''
    desired_quote_char = u'"'
    quote_search = url_state.DOUBLE_QUOTE_PATTERN

    assert url_state._convert_string_literal(
        u"'hello'",
        quote_initial=quote_initial,
        quote_replace=desired_quote_char,
        quote_search=quote_search) == u"\"hello\""

    assert url_state._convert_string_literal(
        u"'hello\"foo'",
        quote_initial=quote_initial,
        quote_replace=desired_quote_char,
        quote_search=quote_search) == u"\"hello\\\"foo\""


def test_url_safe_to_json():
    assert url_state.url_safe_to_json("""{'a':'b'_'b':'c'}""") == """{"a":"b","b":"c"}"""
    assert url_state.url_safe_to_json("""['a'_true]""") == """["a",true]"""
    assert url_state.url_safe_to_json("""['a',true]""") == """["a",true]"""

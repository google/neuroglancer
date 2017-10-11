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

import collections
import json
import re

from six.moves import urllib

from . import viewer_state
from .json_utils import json_encoder_default
from .json_wrappers import to_json

SINGLE_QUOTE_STRING_PATTERN = u'(\'(?:[^\'\\\\]|(?:\\\\.))*\')'
DOUBLE_QUOTE_STRING_PATTERN = u'("(?:[^\'\\\\]|(?:\\\\.))*")'
SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN = SINGLE_QUOTE_STRING_PATTERN + u'|' + DOUBLE_QUOTE_STRING_PATTERN
DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN = DOUBLE_QUOTE_STRING_PATTERN + u'|' + SINGLE_QUOTE_STRING_PATTERN


DOUBLE_QUOTE_PATTERN = u'^((?:[^"\'\\\\]|(?:\\\\.))*)"'
SINGLE_QUOTE_PATTERN = u'^((?:[^"\'\\\\]|(?:\\\\.))*)\''


def _convert_string_literal(x, quote_initial, quote_replace, quote_search):
    if len(x) >= 2 and x[0] == quote_initial and x[-1] == quote_initial:
        inner = x[1:-1]
        s = quote_replace
        while inner:
            m = re.search(quote_search, inner)
            if m is None:
                s += inner
                break
            s += m.group(1)
            s += u'\\'
            s += quote_replace
            inner = inner[m.end():]
        s += quote_replace
        return s
    return x


def _convert_json_helper(x, desired_comma_char, desired_quote_char):
    comma_search = u'[&_,]'
    if desired_quote_char == u'"':
        quote_initial = u'\''
        quote_search = DOUBLE_QUOTE_PATTERN
        string_literal_pattern = SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN
    else:
        quote_initial = u'"'
        quote_search = SINGLE_QUOTE_PATTERN
        string_literal_pattern = DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN
    s = u''
    while x:
        m = re.search(string_literal_pattern, x)
        if m is None:
            before = x
            x = u''
            replacement = u''
        else:
            before = x[:m.start()]
            x = x[m.end():]
            original_string = m.group(1)
            if original_string is not None:
                replacement = _convert_string_literal(original_string, quote_initial, desired_quote_char, quote_search)
            else:
                replacement = m.group(2)
        s += re.sub(comma_search, desired_comma_char, before)
        s += replacement
    return s


def url_safe_to_json(x):
    return _convert_json_helper(x, u',', u'"')

def json_to_url_safe(x):
    return _convert_json_helper(x, u'_', u'\'')

def url_fragment_to_json(fragment_value):
    unquoted = urllib.parse.unquote(fragment_value)
    if unquoted.startswith('!'):
        unquoted = unquoted[1:]
    return url_safe_to_json(unquoted)


def parse_url_fragment(fragment_value):
    json_string = url_fragment_to_json(fragment_value)
    return viewer_state.ViewerState(
        json.loads(json_string, object_pairs_hook=collections.OrderedDict))


def parse_url(url):
    result = urllib.parse.urlparse(url)
    return parse_url_fragment(result.fragment)

def to_url_fragment(state):
    json_string = json.dumps(to_json(state), separators=(u',', u':'), default=json_encoder_default)
    return urllib.parse.quote(json_string, safe=u'~@#$&()*!+=:;,.?/\'')


default_neuroglancer_url = u'https://neuroglancer-demo.appspot.com'

def to_url(state, prefix=default_neuroglancer_url):
    return u'%s#!%s' % (prefix, to_url_fragment(state))

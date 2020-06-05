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
"""Tests for equivalence_map.py"""

from __future__ import absolute_import

from neuroglancer.segment_colors import (hash_function,
    hex_string_from_segment_id)
import numpy as np

def test_hash_function():
    """ Test that the Python implementation
    of the modified murmur hash function
    returns the same result as the javascript
    implementation for a few different 
    color seed/segment id combinations """
    color_seed = 0
    segment_id = 39
    result = hash_function(state=color_seed,value=segment_id)
    assert result == 761471253

    color_seed = 0
    segment_id = 92
    result = hash_function(state=color_seed,value=segment_id)
    assert result == 2920775201   

    color_seed = 1125505311
    segment_id = 47
    result = hash_function(state=color_seed,value=segment_id)
    assert result == 251450508

    color_seed = 1125505311
    segment_id = 30
    result = hash_function(state=color_seed,value=segment_id)
    assert result == 2403373702

def test_hex_string_from_segment_id():
    """ Test that the hex string obtained
    via the Python implementation is identical to
    the value obtained using the javascript implementation
    for a few different color seed/segment id combinations """
    color_seed = 0
    segment_id = 39
    result = hex_string_from_segment_id(
        color_seed,segment_id)
    assert result.upper() == "#992CFF"

    color_seed = 1965848648
    segment_id = 40
    result = hex_string_from_segment_id(
        color_seed,segment_id)
    assert result.upper() == "#FF981E"

    color_seed = 2183424408
    segment_id = 143
    result = hex_string_from_segment_id(
        color_seed,segment_id)
    assert result.upper() == "#0410FF"
    
    color_seed = 2092967958
    segment_id = 58
    result = hex_string_from_segment_id(
        color_seed,segment_id)
    assert result.upper() == "#FF4ACE"

    


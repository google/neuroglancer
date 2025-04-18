# @license
# Copyright 2024 Google Inc.
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

import pytest
from neuroglancer import json_wrappers

IntIntMap = json_wrappers.typed_map(int, int)
IntList = json_wrappers.typed_list(int)


def test_map_construct():
    m = IntIntMap({10: 15, 20: 30})
    assert m.keys() == {10, 20}
    assert list(m.keys()) == [10, 20]
    assert len(m.keys()) == 2
    assert list(m.values()) == [15, 30]
    assert 15 in m.values()
    assert 16 not in m.values()
    assert len(m.values()) == 2
    assert m.items() == {(10, 15), (20, 30)}
    assert len(m.items()) == 2
    assert (10, 15) in m.items()
    assert (10, 16) not in m.items()
    assert (5, 15) not in m.items()

    assert m.get(5) is None
    assert m.get(5, 6) == 6
    assert m.get(10) == 15
    assert m.get(10, 16) == 15

    with pytest.raises(KeyError):
        m.pop(30)

    assert m.pop(15, None) is None
    assert m.pop(15, "abc") == "abc"
    assert m.pop(10) == 15


def test_list_construct():
    x = IntList([1, "2", 3])
    assert len(x) == 3
    assert list(x) == [1, 2, 3]
    x.append("4")
    assert x[-1] == 4
    with pytest.raises(ValueError):
        x.append("abc")
    with pytest.raises(TypeError):
        x.append([])

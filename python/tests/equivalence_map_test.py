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

from neuroglancer import equivalence_map


def test_basic():

    m = equivalence_map.EquivalenceMap()

    for i in range(24):
        assert 0 == m[i]
        assert i + 1 == m[i + 1]
        assert set([i + 1]) == set(m.members(i + 1))
        result = m.union(i, i + 1)
        assert result == 0
        assert 0 == m[i]
        assert 0 == m[i + 1]
        assert set(range(i + 2)) == set(m.members(i))

    for i in range(25, 49):
        assert 25 == m[i]
        assert i + 1 == m[i + 1]
        result = m.union(i, i + 1)
        assert result == 25
        assert 25 == m[i]
        assert 25 == m[i + 1]
        assert set(range(25, i + 2)) == set(m.members(i))
    assert m[15] != m[40]
    result = m.union(15, 40)
    assert 0 == result
    assert 0 == m[15]
    assert 0 == m[40]
    assert set(range(50)) == set(m.members(15))

    for i in range(50):
        assert 0 == m[i]
        assert set(range(50)) == set(m.members(i))

    for i in range(51, 100):
        assert set([i]) == set(m.members(i))


def test_init_simple():
    m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
    assert 1 == m[1]
    assert 1 == m[2]
    assert 1 == m[3]
    assert 4 == m[4]
    assert 4 == m[5]
    assert set([1, 2, 3, 4, 5]) == set(m.keys())
    assert [[1, 2, 3], [4, 5]] == m.to_json()


def test_delete_set():
    m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
    m.delete_set(5)
    assert [[1, 2, 3]] == m.to_json()


def test_isolate_element():
    m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
    m.isolate_element(1)
    assert [[2, 3], [4, 5]] == m.to_json()

    m.isolate_element(1)
    assert [[2, 3], [4, 5]] == m.to_json()

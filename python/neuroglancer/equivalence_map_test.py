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

import unittest

from . import equivalence_map


class EquivalenceMapTest(unittest.TestCase):
    def test_basic(self):

        m = equivalence_map.EquivalenceMap()

        for i in range(24):
            self.assertEqual(0, m[i])
            self.assertEqual(i + 1, m[i + 1])
            self.assertEqual(set([i + 1]), set(m.members(i + 1)))
            result = m.union(i, i + 1)
            self.assertEqual(result, 0)
            self.assertEqual(0, m[i])
            self.assertEqual(0, m[i + 1])
            self.assertEqual(set(range(i + 2)), set(m.members(i)))

        for i in range(25, 49):
            self.assertEqual(25, m[i])
            self.assertEqual(i + 1, m[i + 1])
            result = m.union(i, i + 1)
            self.assertEqual(result, 25)
            self.assertEqual(25, m[i])
            self.assertEqual(25, m[i + 1])
            self.assertEqual(set(range(25, i + 2)), set(m.members(i)))
        self.assertNotEqual(m[15], m[40])
        result = m.union(15, 40)
        self.assertEqual(0, result)
        self.assertEqual(0, m[15])
        self.assertEqual(0, m[40])
        self.assertEqual(set(range(50)), set(m.members(15)))

        for i in range(50):
            self.assertEqual(0, m[i])
            self.assertEqual(set(range(50)), set(m.members(i)))

        for i in range(51, 100):
            self.assertEqual(set([i]), set(m.members(i)))

    def test_init_simple(self):
        m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
        self.assertEqual(1, m[1])
        self.assertEqual(1, m[2])
        self.assertEqual(1, m[3])
        self.assertEqual(4, m[4])
        self.assertEqual(4, m[5])
        self.assertEqual(set([1, 2, 3, 4, 5]), set(m.keys()))
        self.assertEqual([[1, 2, 3], [4, 5]], m.to_json())

    def test_delete_set(self):
        m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
        m.delete_set(5)
        self.assertEqual([[1, 2, 3]], m.to_json())

    def test_isolate_element(self):
        m = equivalence_map.EquivalenceMap([[1, 2, 3], [4, 5]])
        m.isolate_element(1)
        self.assertEqual([[2, 3], [4, 5]], m.to_json())

        m.isolate_element(1)
        self.assertEqual([[2, 3], [4, 5]], m.to_json())


if __name__ == '__main__':
    unittest.main()

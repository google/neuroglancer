# @license
# Copyright 2018 Google Inc.
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
"""Tests for merge_tool.py"""

from __future__ import absolute_import

import unittest

from . import merge_tool


class BlockMaskTest(unittest.TestCase):
    def test_basic(self):

        mask = merge_tool.BlockMask()
        mask.add(0, (5, 3, 1))

        self.assertEqual(mask.blocks, [{
            (5, 3, 1): 1
        }, {
            (2, 1, 0): 1
        }, {
            (1, 0, 0): 1
        }, {
            (0, 0, 0): 1
        }])

        mask.add(0, (5, 3, 0))
        self.assertEqual(mask.blocks, [
            {
                (5, 3, 0): 1,
                (5, 3, 1): 1
            },
            {
                (2, 1, 0): 2
            },
            {
                (1, 0, 0): 2
            },
            {
                (0, 0, 0): 2
            },
        ])

        mask.add(0, (5, 2, 1))
        mask.add(0, (5, 2, 0))

        mask.add(0, (4, 2, 1))
        mask.add(0, (4, 2, 0))
        mask.add(0, (4, 3, 1))
        self.assertEqual(mask.blocks, [
            {
                (4, 2, 1): 1,
                (4, 2, 0): 1,
                (4, 3, 1): 1,
                (5, 2, 0): 1,
                (5, 2, 1): 1,
                (5, 3, 0): 1,
                (5, 3, 1): 1
            },
            {
                (2, 1, 0): 7
            },
            {
                (1, 0, 0): 7
            },
            {
                (0, 0, 0): 7
            },
        ])

        mask.add(0, (4, 3, 0))
        self.assertEqual(mask.blocks, [
            {},
            {
                (2, 1, 0): 8
            },
            {
                (1, 0, 0): 8
            },
            {
                (0, 0, 0): 8
            },
        ])

        mask.remove(0, (4, 3, 0))
        self.assertEqual(mask.blocks, [
            {
                (4, 2, 1): 1,
                (4, 2, 0): 1,
                (4, 3, 1): 1,
                (5, 2, 0): 1,
                (5, 2, 1): 1,
                (5, 3, 0): 1,
                (5, 3, 1): 1
            },
            {
                (2, 1, 0): 7
            },
            {
                (1, 0, 0): 7
            },
            {
                (0, 0, 0): 7
            },
        ])

        mask.remove(1, (2, 1, 0))
        self.assertEqual(mask.blocks, [{}, {}, {}, {}])


if __name__ == '__main__':
    unittest.main()

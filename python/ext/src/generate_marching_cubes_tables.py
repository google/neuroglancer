# @license
# Copyright 2016 Google Inc.
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

from __future__ import print_function

cube_corner_position_offsets = [
    [0, 0, 0],  #
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1]
]

cube_edge_index_to_corner_index_pair_table = [
    [0, 1],
    [1, 2],
    [3, 2],
    [0, 3],
    [4, 5],
    [5, 6],
    [7, 6],
    [4, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
]

for edge_i, corners in enumerate(cube_edge_index_to_corner_index_pair_table):
    if cube_corner_position_offsets[corners[0]] > cube_corner_position_offsets[corners[1]]:
        print('edge %d is flipped' % (edge_i))

cube_edge_vertex_map_selectors_table = [0] * 256
cube_edge_mask_table = [0] * 256

for corners_present in range(256):
    selectors = 0
    edge_mask = 0
    for edge_i, corners in enumerate(cube_edge_index_to_corner_index_pair_table):
        edge_corners_present = [(corners_present >> corner_i) & 1 for corner_i in corners]
        if 0 in edge_corners_present and 1 in edge_corners_present:
            edge_mask |= (1 << edge_i)
        selector = edge_corners_present[0]
        selectors |= selector << edge_i
    cube_edge_mask_table[corners_present] = edge_mask
    cube_edge_vertex_map_selectors_table[corners_present] = selectors

print('static uint32_t cube_edge_mask_table[256] = {')
print(', '.join(map(hex, cube_edge_mask_table)))
print('};')

print('static uint32_t cube_edge_vertex_map_selectors_table[256] = {')
print(', '.join(map(hex, cube_edge_vertex_map_selectors_table)))
print('};')

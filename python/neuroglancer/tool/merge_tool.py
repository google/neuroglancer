#!/usr/bin/env python
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

from __future__ import print_function, division

import argparse
import collections
import copy
import json
import math
import os
import uuid
import webbrowser

import numpy as np

import neuroglancer
import neuroglancer.url_state
from neuroglancer.json_utils import json_encoder_default

def get_segmentation_layer(layers):
    for layer in layers:
        if isinstance(layer.layer, neuroglancer.SegmentationLayer):
            return layer

def _full_count_for_level(level):
    return (2**level)**3

class BlockMask(object):
    def __init__(self, max_level=3):
        # self.blocks[level_i][position] specifies the number of base elements contained within the block
        self.blocks = [dict() for _ in range(max_level+1)]

    def _remove_children(self, level, position):
        position = tuple(position)
        if level == 0:
            return
        for offset in np.ndindex((2,) * 3):
            self._remove(level - 1, tuple(x * 2 + o for x, o in zip(position, offset)))

    def _remove(self, level, position):
        position = tuple(position)
        old_count = self.blocks[level].pop(position, 0)
        if old_count == 0 or old_count == _full_count_for_level(level):
            return old_count
        self._remove_children(level, position)
        return old_count

    def _contains(self, level, position):
        position = tuple(position)
        blocks = self.blocks
        while True:
            count = blocks[level].get(position, 0)
            if count == _full_count_for_level(level):
                return level, position
            position = tuple(x // 2 for x in position)
            level += 1
            if level >= len(blocks):
                return None, None

    def _add_children(self, level, position, excluded_child_position, excluded_child_count):
        blocks = self.blocks
        full_count_for_child = _full_count_for_level(level-1)
        for offset in np.ndindex((2,) * 3):
            child_position = tuple(x * 2 + o for x, o in zip(position, offset))
            count = full_count_for_child
            if child_position == excluded_child_position:
                count -= excluded_child_count
            if count != 0:
                blocks[level-1][child_position] = count

    def _add_children_along_path(self, start_level, end_level, start_position):
        excluded_count = _full_count_for_level(start_level)
        while start_level < end_level:
            parent_position = tuple(x // 2 for x in start_position)
            start_level += 1
            self._add_children(start_level, parent_position, start_position, excluded_count)
            start_position = parent_position


    def add(self, level, position):
        if self._contains(level, position)[0] is not None:
            return
        position = tuple(position)
        old_count = self.blocks[level].get(position, 0)
        self._adjust_count(level, position, _full_count_for_level(level) - old_count)

    def remove(self, level, position):
        position = tuple(position)
        old_count = self.blocks[level].get(position, 0)
        if old_count == 0:
            old_level, position_in_old_level = self._contains(level, position)
            if old_level is None:
                return
            if old_level != level:
                self._adjust_count(old_level, position_in_old_level, -_full_count_for_level(level))
                self._add_children_along_path(level, old_level, position)
                return
        if old_count != _full_count_for_level(level):
            self._remove_children(level, position)
        self._adjust_count(level, position, -old_count)

    def _adjust_count(self, level, position, amount):
        if amount == 0:
            return
        old_count = self.blocks[level].get(position, 0)
        new_count = old_count + amount
        if new_count == 0:
            del self.blocks[level][position]
        else:
            self.blocks[level][position] = new_count

        if level > 0 and new_count == _full_count_for_level(level):
            self._remove_children(level, position)

        if level + 1 < len(self.blocks):
            self._adjust_count(level + 1, tuple(x // 2 for x in position), amount)

def make_block_mask(annotations, block_size, max_level=3):
    mask = BlockMask(max_level=max_level)
    for x in annotations:
        if not isinstance(x, neuroglancer.AxisAlignedBoundingBoxAnnotation):
            print('Warning: got non-box annotation: %r' % (x,))
            continue
        size = (x.point_b - x.point_a) / block_size
        if size[0] != int(size[0]) or np.any(size != size[0]):
            print('Warning: got invalid box: %r' % (x,))
            continue
        level = math.log(size[0]) / math.log(2)
        if level != int(level):
            print('Warning: got invalid box: %r' % (x,))
            continue
        level = int(level)
        eff_block_size = block_size * (2**level)
        if np.any(x.point_a % eff_block_size != 0):
            print('Warning: got invalid box: %r' % (x,))
            continue
        position = tuple(int(z) for z in x.point_a // eff_block_size)
        mask.add(level, position)
    return mask

def make_annotations_from_mask(mask, block_size):
    result = []
    for level, position_counts in enumerate(mask.blocks):
        full_count = _full_count_for_level(level)
        eff_block_size = block_size * 2**level
        for position in position_counts:
            count = position_counts[position]
            if count != full_count:
                continue
            position = np.array(position, dtype=np.int64)
            box_start = eff_block_size * position
            box_end = box_start + eff_block_size
            result.append(neuroglancer.AxisAlignedBoundingBoxAnnotation(
                point_a = box_start,
                point_b = box_end,
                id = uuid.uuid4().hex,
            ))
    return result


def normalize_block_annotations(annotations, block_size, max_level=3):
    mask = make_block_mask(annotations=annotations, block_size=block_size, max_level=max_level)
    return make_annotations_from_mask(mask=mask, block_size=block_size)


class Annotator(object):
    def __init__(self, filename):
        self.filename = filename
        self.annotation_layer_name = 'false-merges'
        self.states = []
        self.state_index = None
        self.false_merge_block_size = np.array([32, 32, 32], dtype=np.int64)
        self.false_merge_block_level = 0
        self.max_false_merge_block_levels = 3
        viewer = self.viewer = neuroglancer.Viewer()
        self.other_state_segment_ids = dict()

        viewer.actions.add('anno-next-state', lambda s: self.next_state())
        viewer.actions.add('anno-prev-state', lambda s: self.prev_state())
        viewer.actions.add('anno-save', lambda s: self.save())
        viewer.actions.add('anno-show-all', lambda s: self.set_combined_state())
        viewer.actions.add('anno-add-segments-from-state',
                           lambda s: self.add_segments_from_state(s.viewer_state))
        viewer.actions.add('anno-mark-false-merge', self.mark_false_merge)
        viewer.actions.add('anno-unmark-false-merge', lambda s: self.mark_false_merge(s, erase=True))
        viewer.actions.add('anno-decrease-block-size', self.decrease_false_merge_block_size)
        viewer.actions.add('anno-increase-block-size', self.increase_false_merge_block_size)

        with viewer.config_state.txn() as s:
            s.input_event_bindings.data_view['pageup'] = 'anno-prev-state'
            s.input_event_bindings.data_view['pagedown'] = 'anno-next-state'
            s.input_event_bindings.data_view['bracketleft'] = 'anno-decrease-block-size'
            s.input_event_bindings.data_view['bracketright'] = 'anno-increase-block-size'
            s.input_event_bindings.data_view['control+keys'] = 'anno-save'
            s.input_event_bindings.data_view['control+keya'] = 'anno-show-all'
            s.input_event_bindings.data_view['control+mousedown0'] = 'anno-mark-false-merge'
            s.input_event_bindings.data_view['control+shift+mousedown0'] = 'anno-unmark-false-merge'

        viewer.shared_state.add_changed_callback(self.on_state_changed)
        self.cur_message = None
        if not self.load():
            self.set_state_index(None)

    def increase_false_merge_block_size(self, s):
        self.false_merge_block_level = min(self.max_false_merge_block_levels, self.false_merge_block_level + 1)
        self.update_message()

    def decrease_false_merge_block_size(self, s):
        self.false_merge_block_level = max(0, self.false_merge_block_level - 1)
        self.update_message()

    def mark_false_merge(self, s, erase=False):
        voxel_coordinates = s.mouse_voxel_coordinates
        if voxel_coordinates is None:
            return
        block_size = self.false_merge_block_size
        level = self.false_merge_block_level
        full_block_size = block_size * 2**level
        block_position = voxel_coordinates // full_block_size

        with self.viewer.txn() as s:
            annotations = s.layers[self.annotation_layer_name].annotations
            mask = make_block_mask(annotations=annotations, block_size=block_size, max_level=self.max_false_merge_block_levels)
            if erase:
                mask.remove(level, block_position)
            else:
                mask.add(level, block_position)
            new_annotations = make_annotations_from_mask(mask=mask, block_size=block_size)
            s.layers[self.annotation_layer_name].annotations = new_annotations

    def on_state_changed(self):
        # Check if we should warn about segments
        self.update_message()

    def update_message(self):
        message = '[Block size: %d vx] ' % (self.false_merge_block_size[0] * 2**self.false_merge_block_level)
        if self.state_index is None:
            message += '[No state selected]'
        else:
            message += '[%d/%d] ' % (self.state_index, len(self.states))
            segments = self.get_state_segment_ids(self.viewer.state)
            warnings = []
            for segment_id in segments:
                other_state = self.other_state_segment_ids.get(segment_id)
                if other_state is not None:
                    warnings.append('Segment %d also in state %d' % (segment_id, other_state))
            if warnings:
                message += 'WARNING: ' + ', '.join(warnings)
        if message != self.cur_message:
            with self.viewer.config_state.txn() as s:
                if message is not None:
                    s.status_messages['status'] = message
                else:
                    s.status_messages.pop('status')
            self.cur_message = message

    def load(self):
        if not os.path.exists(self.filename):
            return False
        self.state_index = None

        with open(self.filename, 'r') as f:

            loaded_state = json.load(f, object_pairs_hook=collections.OrderedDict)
        self.states = [neuroglancer.ViewerState(x) for x in loaded_state['states']]
        self.set_state_index(loaded_state['state_index'])
        return True

    def set_state_index_relative(self, amount):
        if self.state_index is None:
            new_state = 0
        else:
            new_state = (self.state_index + amount + len(self.states)) % len(self.states)
        self.set_state_index(new_state)

    def next_state(self):
        self.set_state_index_relative(1)

    def prev_state(self):
        self.set_state_index_relative(-1)

    def set_state_index(self, index):
        self._grab_viewer_state()
        self.state_index = index
        if index is None:
            self.viewer.set_state(neuroglancer.ViewerState())
        else:
            new_state = copy.deepcopy(self.states[index])
            anno_layer = new_state.layers[self.annotation_layer_name]
            if anno_layer.annotation_fill_opacity == 0:
                anno_layer.annotation_fill_opacity = 0.7
            anno_layer.annotation_color = 'black'
            anno_layer.annotations = normalize_block_annotations(
                anno_layer.annotations,
                block_size=self.false_merge_block_size,
                max_level=self.max_false_merge_block_levels)
            self.viewer.set_state(new_state)
            other_ids = self.other_state_segment_ids
            other_ids.clear()
            other_ids[0] = -1
            for i, state in enumerate(self.states):
                if i == self.state_index:
                    continue
                for x in self.get_state_segment_ids(state):
                    other_ids[x] = i
        self.update_message()

    def get_duplicate_segment_ids(self):
        self._grab_viewer_state()
        other_ids = dict()
        other_ids[0] = [-1]
        for i, state in enumerate(self.states):
            for x in self.get_state_segment_ids(state):
                other_ids.setdefault(x, []).append(i)
        for segment_id in other_ids:
            state_numbers = other_ids[segment_id]
            if len(state_numbers) > 1:
                print('%d in %r' % (segment_id, state_numbers))

    def _grab_viewer_state(self):
        if self.state_index is not None:
            self.states[self.state_index] = copy.deepcopy(self.viewer.state)

    def save(self):
        self._grab_viewer_state()
        tmp_filename = self.filename + '.tmp'
        with open(tmp_filename, 'wb') as f:
            f.write(
                json.dumps(
                    dict(states=[s.to_json() for s in self.states], state_index=self.state_index),
                    default=json_encoder_default))
        os.rename(tmp_filename, self.filename)
        print('Saved state to: %s' % (self.filename, ))

    def get_state_segment_ids(self, state):
        return get_segmentation_layer(state.layers).segments

    def get_existing_segment_ids(self):
        ids = set()
        for state in self.states:
            ids.update(self.get_state_segment_ids(state))
        return ids

    def add_segments_from_state(self, base_state):
        if isinstance(base_state, basestring):
            base_state = neuroglancer.parse_url(base_state)
        elif isinstance(base_state, dict):
            base_state = neuroglancer.ViewerState(base_state)

        segment_ids = self.get_state_segment_ids(base_state)

        existing_segment_ids = self.get_existing_segment_ids()

        for segment_id in segment_ids:
            if segment_id in existing_segment_ids:
                print('Skipping redundant segment id %d' % segment_id)
                continue
            self.states.append(self.make_initial_state(segment_id, base_state))

        if self.state_index is None:
            self.next_state()

    def make_initial_state(self, segment_id, base_state):
        state = copy.deepcopy(base_state)

        segments = self.get_state_segment_ids(state)
        segments.clear()
        segments.add(segment_id)
        state.layers[self.annotation_layer_name] = neuroglancer.AnnotationLayer()

        return state

    def remove_zero_segments(self):
        for state in self.states:
            segment_ids = self.get_state_segment_ids(state)
            if 0 in segment_ids:
                segment_ids.remove(0)

    def set_combined_state(self):
        state = self.make_combined_state()
        if state is None:
            print('No states')
        else:
            self.set_state_index(None)
            self.viewer.set_state(state)

    def make_combined_state(self):
        if len(self.states) == 0:
            return None

        state = copy.deepcopy(self.states[0])
        layer = get_segmentation_layer(state.layers)
        layer.segments.clear()
        points = state.layers[self.annotation_layer_name].annotations
        for i, other_state in enumerate(self.states):
            other_segments = self.get_state_segment_ids(other_state)
            # print('%d: %r' % (i, other_segments))
            if other_segments:
                u_result = layer.equivalences.union(*other_segments)
                layer.segments.add(u_result)
            points.extend(other_state.layers[self.annotation_layer_name].annotations)
        return state

    def show(self):
        webbrowser.open_new(self.viewer.get_viewer_url())

    def get_viewer_url(self):
        return self.viewer.get_viewer_url()

    def get_sets(self):
        sets = []
        for other_state in self.states:
            other_segments = self.get_state_segment_ids(other_state)
            if other_segments:
                sets.append(sorted(other_segments))
        return sets


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('filename', type=str)
    ap.add_argument('--add-segments-from-url', type=str, nargs='*', default=[])
    ap.add_argument(
        '-n', '--no-webbrowser', action='store_true', help='Don\'t open the webbrowser.')
    ap.add_argument('--print-sets', action='store_true', help='Print the sets of supervoxels.')
    ap.add_argument(
        '--print-combined-state',
        action='store_true',
        help='Prints a neuroglancer link for the combined state.')
    ap.add_argument(
        '--print-summary',
        action='store_true',
        help='Prints a neuroglancer link for the combined state.')
    ap.add_argument(
        '-a',
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    ap.add_argument(
        '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')

    args = ap.parse_args()
    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)

    anno = Annotator(args.filename)
    for url in args.add_segments_from_url:
        anno.add_segments_from_state(url)

    if args.print_sets:
        print(repr(anno.get_sets()))

    if args.print_combined_state:
        print(neuroglancer.to_url(anno.make_combined_state()))

    if args.print_summary:
        print('<html>')
        print('<h1>%s</h1>' % args.filename)
        print(
            '<a href="%s">Neuroglancer</a><br/>' % neuroglancer.to_url(anno.make_combined_state()))
        print(repr(anno.get_sets()))
        print('</html>')

    else:
        print(anno.get_viewer_url())
    if not args.no_webbrowser:
        anno.show()

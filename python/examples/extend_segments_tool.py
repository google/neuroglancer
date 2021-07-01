#!/usr/bin/env python2
"""Tool for extending via equivalences a set of segments."""

from __future__ import absolute_import, print_function

import argparse
import copy
import os
import webbrowser

import neuroglancer
from neuroglancer.json_utils import decode_json, encode_json

neuroglancer.set_static_content_source(url='http://localhost:8080')


def get_segmentation_layer(layers):
    for layer in layers:
        if isinstance(layer.layer, neuroglancer.SegmentationLayer):
            return layer


class Annotator(object):
    def __init__(self, filename):
        self.filename = filename
        self.point_annotation_layer_name = 'false-merges'
        self.states = []
        self.state_index = None
        viewer = self.viewer = neuroglancer.Viewer()
        self.other_state_segment_ids = dict()

        viewer.actions.add('anno-next-state', lambda s: self.next_state())
        viewer.actions.add('anno-prev-state', lambda s: self.prev_state())
        viewer.actions.add('anno-save', lambda s: self.save())
        viewer.actions.add('anno-show-all', lambda s: self.set_combined_state())
        viewer.actions.add('anno-add-segments-from-state',
                           lambda s: self.add_segments_from_state(s.viewer_state))

        with viewer.config_state.txn() as s:
            s.input_event_bindings.viewer['pageup'] = 'anno-prev-state'
            s.input_event_bindings.viewer['pagedown'] = 'anno-next-state'
            s.input_event_bindings.viewer['control+keys'] = 'anno-save'
            s.input_event_bindings.viewer['control+keya'] = 'anno-show-all'

        viewer.shared_state.add_changed_callback(self.on_state_changed)
        self.cur_message = None
        if not self.load():
            self.set_state_index(None)

    def on_state_changed(self):
        self.update_message()

    def update_message(self):
        if self.state_index is None:
            message = '[No state selected]'
        else:
            message = '[%d/%d] ' % (self.state_index, len(self.states))
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
            loaded_state = decode_json(f.read())
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
            self.viewer.set_state(self.states[index])
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
                encode_json(
                    dict(states=[s.to_json() for s in self.states], state_index=self.state_index)))
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
        if isinstance(base_state, str):
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
        state.layers[self.point_annotation_layer_name] = neuroglancer.PointAnnotationLayer()

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
        points = state.layers[self.point_annotation_layer_name].points
        for other_state in self.states:
            other_segments = self.get_state_segment_ids(other_state)
            if other_segments:
                u_result = layer.equivalences.union(*other_segments)
                layer.segments.add(u_result)
            points.extend(other_state.layers[self.point_annotation_layer_name].points)
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

    def print_combined_state_url(self):
        print(neuroglancer.to_url(self.make_combined_state()))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('filename', type=str)
    ap.add_argument(
        '-a',
        '--add-segments-from-url',
        type=str,
        nargs='*',
        default=[],
        help='Add a new state for each selected segment specified by a Neuroglancer URL.')
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
    args = ap.parse_args()

    anno = Annotator(args.filename)
    for url in args.add_segments_from_url:
        anno.add_segments_from_state(url)

    if args.print_sets:
        print(repr(anno.get_sets()))

    if args.print_combined_state:
        anno.print_combined_state_url()

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

from __future__ import division

import json
import os
import copy
import collections
import argparse
import csv

import neuroglancer
import numpy as np


class State(object):
    def __init__(self, path):
        self.path = path
        self.body_labels = collections.OrderedDict()

    def load(self):
        if os.path.exists(self.path):
            with open(self.path, 'r') as f:
                self.body_labels = collections.OrderedDict(json.load(f))

    def save(self):
        tmp_path = self.path + '.tmp'
        with open(tmp_path, 'w') as f:
            f.write(json.dumps(self.body_labels.items()))
        os.rename(tmp_path, self.path)


Body = collections.namedtuple('Body', ['segment_id', 'num_voxels', 'bbox_start', 'bbox_size'])


class Tool(object):
    def __init__(self, state_path, bodies, labels, segmentation_url, image_url, num_to_prefetch):
        self.state = State(state_path)
        self.num_to_prefetch = num_to_prefetch
        self.viewer = neuroglancer.Viewer()
        self.bodies = bodies
        self.state.load()
        self.total_voxels = sum(x.num_voxels for x in bodies)
        self.cumulative_voxels = np.cumsum([x.num_voxels for x in bodies])

        with self.viewer.txn() as s:
            s.layers['image'] = neuroglancer.ImageLayer(source=image_url)
            s.layers['segmentation'] = neuroglancer.SegmentationLayer(source=segmentation_url)
            s.navigation.zoom_factor = 66
            s.perspective_zoom = 1280
            s.show_slices = False
            s.concurrent_downloads = 256
            s.gpu_memory_limit = 2 * 1024 * 1024 * 1024
            s.layout = '3d'

        key_bindings = [
            ['bracketleft', 'prev-index'],
            ['bracketright', 'next-index'],
            ['home', 'first-index'],
            ['end', 'last-index'],
            ['control+keys', 'save'],
        ]
        label_keys = ['keyd', 'keyf', 'keyg', 'keyh']
        for label, label_key in zip(labels, label_keys):
            key_bindings.append([label_key, 'label-%s' % label])

            def label_func(s, label=label):
                self.set_label(s, label)

            self.viewer.actions.add('label-%s' % label, label_func)
        self.viewer.actions.add('prev-index', self._prev_index)
        self.viewer.actions.add('next-index', self._next_index)
        self.viewer.actions.add('first-index', self._first_index)
        self.viewer.actions.add('last-index', self._last_index)
        self.viewer.actions.add('save', self.save)

        with self.viewer.config_state.txn() as s:
            for key, command in key_bindings:
                s.input_event_bindings.viewer[key] = command
            s.status_messages['help'] = ('KEYS: ' + ' | '.join('%s=%s' % (key, command)
                                                               for key, command in key_bindings))

        self.index = -1
        self.set_index(self._find_one_after_last_labeled_index())

    def _find_one_after_last_labeled_index(self):
        body_index = 0
        while self.bodies[body_index].segment_id in self.state.body_labels:
            body_index += 1
        return body_index

    def set_index(self, index):
        if index == self.index:
            return
        body = self.bodies[index]
        self.index = index

        def modify_state_for_body(s, body):
            s.layers['segmentation'].segments = frozenset([body.segment_id])
            s.voxel_coordinates = body.bbox_start + body.bbox_size // 2

        with self.viewer.txn() as s:
            modify_state_for_body(s, body)

        prefetch_states = []
        for i in range(self.num_to_prefetch):
            prefetch_index = self.index + i + 1
            if prefetch_index >= len(self.bodies):
                break
            prefetch_state = copy.deepcopy(self.viewer.state)
            prefetch_state.layout = '3d'
            modify_state_for_body(prefetch_state, self.bodies[prefetch_index])
            prefetch_states.append(prefetch_state)

        with self.viewer.config_state.txn() as s:
            s.prefetch = [
                neuroglancer.PrefetchState(state=prefetch_state, priority=-i)
                for i, prefetch_state in enumerate(prefetch_states)
            ]

        label = self.state.body_labels.get(body.segment_id, '')
        with self.viewer.config_state.txn() as s:
            s.status_messages['status'] = (
                '[Segment %d/%d  : %d/%d voxels labeled = %.3f fraction] label=%s' %
                (index, len(self.bodies), self.cumulative_voxels[index], self.total_voxels,
                 self.cumulative_voxels[index] / self.total_voxels, label))

    def save(self, s):
        self.state.save()

    def set_label(self, s, label):
        self.state.body_labels[self.bodies[self.index].segment_id] = label
        self.set_index(self.index + 1)

    def _first_index(self, s):
        self.set_index(0)

    def _last_index(self, s):
        self.set_index(max(0, self._find_one_after_last_labeled_index() - 1))

    def _next_index(self, s):
        self.set_index(self.index + 1)

    def _prev_index(self, s):
        self.set_index(max(0, self.index - 1))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--image-url', required=True, help='Neuroglancer data source URL for image')
    ap.add_argument(
        '--segmentation-url', required=True, help='Neuroglancer data source URL for segmentation')

    ap.add_argument('--state', required=True, help='Path to proofreading state file')

    ap.add_argument('--bodies', required=True, help='Path to list of bodies to proofread')
    ap.add_argument(
        '-a',
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    ap.add_argument(
        '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')

    ap.add_argument('--labels', nargs='+', help='Labels to use')
    ap.add_argument('--prefetch', type=int, default=10, help='Number of bodies to prefetch')

    args = ap.parse_args()
    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)

    bodies = []

    with open(args.bodies, 'r') as f:
        csv_reader = csv.DictReader(f)
        for row in csv_reader:
            bodies.append(
                Body(
                    segment_id=int(row['id']),
                    num_voxels=int(row['num_voxels']),
                    bbox_start=np.array(
                        [
                            int(row['bbox.start.x']),
                            int(row['bbox.start.y']),
                            int(row['bbox.start.z'])
                        ],
                        dtype=np.int64),
                    bbox_size=np.array(
                        [int(row['bbox.size.x']),
                         int(row['bbox.size.y']),
                         int(row['bbox.size.z'])],
                        dtype=np.int64),
                ))

    tool = Tool(
        state_path=args.state,
        image_url=args.image_url,
        segmentation_url=args.segmentation_url,
        labels=args.labels,
        bodies=bodies,
        num_to_prefetch=args.prefetch,
    )
    print(tool.viewer)

#!/usr/bin/env python
"""Example of interactive visualization of synaptic partners.

To run this example, first download the synapse data for FIB-25 from the Janelia DVID server using this URL:

http://emdata.janelia.org/api/node/822524777d3048b8bd520043f90c1d28/.files/key/synapse.json

Then invoke this example script with the path to the downloaded synapse.json
file.

To display synaptic partner information, select one or more segments in the left
panel.  The middle panel shows the selected segments, and their associated
pre-synaptic and post-synaptic sites as line segments.  The right panel shows
the top N synaptic partners in common between the selected segments.
"""

import collections
import json
import time
import six

import neuroglancer
import neuroglancer.cli

def get_synapses_by_id(synapse_data):
    synapses_by_id = {}
    partner_counts = {}
    for x in synapse_data:
        pre_id = x['T-bar']['body ID']
        synapses_by_id.setdefault(pre_id, []).append(x)
        for partner in x['partners']:
            post_id = partner['body ID']
            synapses_by_id.setdefault(post_id, []).append(x)
            partner_counts.setdefault(pre_id, collections.Counter())[post_id] += 1
            partner_counts.setdefault(post_id, collections.Counter())[pre_id] += 1

    return synapses_by_id, partner_counts


class Demo(object):
    def __init__(self, synapse_path, top_method='min', num_top_partners=10):
        with open(synapse_path, 'r') as f:
            synapse_data = json.load(f)['data']
        self.synapses_by_id, self.synapse_partner_counts = get_synapses_by_id(synapse_data)
        self.top_method = top_method
        self.num_top_partners = num_top_partners

        dimensions = neuroglancer.CoordinateSpace(
            names=['x', 'y', 'z'],
            units='nm',
            scales=[8, 8, 8],
        )

        viewer = self.viewer = neuroglancer.Viewer()
        viewer.actions.add('select-custom', self._handle_select)
        with viewer.config_state.txn() as s:
            s.input_event_bindings.data_view['dblclick0'] = 'select-custom'
        with viewer.txn() as s:
            s.projection_orientation = [0.63240087, 0.01582051, 0.05692779, 0.77238464]
            s.dimensions = dimensions
            s.position = [3000, 3000, 3000]
            s.layers['image'] = neuroglancer.ImageLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
            )
            s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
            )
            s.layers['partners'] = neuroglancer.SegmentationLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
            )
            s.layers['synapses'] = neuroglancer.LocalAnnotationLayer(
                dimensions=dimensions,
                linked_segmentation_layer='ground_truth')
            s.layout = neuroglancer.row_layout([
                neuroglancer.LayerGroupViewer(
                    layout='xy',
                    layers=['image', 'ground_truth', 'partners', 'synapses'],
                ),
                neuroglancer.LayerGroupViewer(
                    layout='3d',
                    layers=['ground_truth', 'synapses'],
                ),
                neuroglancer.LayerGroupViewer(
                    layout='3d',
                    layers=['partners', 'synapses'],
                ),
            ])

        self.selected_segments = frozenset()
        self.viewer.shared_state.add_changed_callback(
            lambda: self.viewer.defer_callback(self.on_state_changed))

    def _handle_select(self, action_state):
        segment_id = action_state.selected_values.get('ground_truth')
        if segment_id is None: return
        segment_id = segment_id.value
        with self.viewer.txn() as s:
            segments = s.layers['ground_truth'].segments
            if segment_id in segments:
                segments.remove(segment_id)
            else:
                segments.add(segment_id)

    def on_state_changed(self):
        new_segments = self.viewer.state.layers['ground_truth'].segments
        if new_segments != self.selected_segments:
            self.selected_segments = new_segments
            self.viewer.defer_callback(
                self._update_synapses)

    def _update_synapses(self):
        synapses = {}
        partner_counts = None
        for segment_id in self.selected_segments:
            for synapse in self.synapses_by_id.get(segment_id, []):
                synapses[id(synapse)] = synapse

        for segment_id in self.selected_segments:
            cur_counts = self.synapse_partner_counts.get(segment_id, collections.Counter())
            if partner_counts is None:
                partner_counts = cur_counts
                continue
            if self.top_method == 'sum':
                partner_counts = partner_counts + cur_counts
            elif self.top_method == 'min':
                partner_counts = partner_counts & cur_counts
        if partner_counts is None:
            partner_counts = collections.Counter()
        top_partners = sorted(
            (x for x in partner_counts.keys() if x not in self.selected_segments),
            key=lambda x: -partner_counts[x])
        top_partners = top_partners[:self.num_top_partners]
        with self.viewer.txn() as s:
            s.layers['partners'].segments = top_partners
            annotations = s.layers['synapses'].annotations
            del annotations[:]
            for synapse in six.itervalues(synapses):
                tbar = synapse['T-bar']
                for partner in synapse['partners']:
                    annotations.append(
                        neuroglancer.LineAnnotation(
                            id='%d' % id(partner),
                            point_a=tbar['location'],
                            point_b=partner['location'],
                            segments=[tbar['body ID'], partner['body ID']],
                        ))

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument(
        'synapses',
        help=
        'Path to synapse.json file downloaded from http://emdata.janelia.org/api/node/822524777d3048b8bd520043f90c1d28/.files/key/synapse.json'
    )
    ap.add_argument(
        '-n',
        '--num-partners',
        default=10,
        type=int,
        help='Number of top synaptic partners to display.')
    ap.add_argument(
        '--order',
        choices=['min', 'sum'],
        default='min',
        help='Method by which to combine synaptic partner counts from multiple segments.')
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    demo = Demo(
        synapse_path=args.synapses,
        num_top_partners=args.num_partners,
        top_method=args.order,
    )
    print(demo.viewer)
    import time
    time.sleep(5000)
    while True:
        time.sleep(1000)

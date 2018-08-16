#!/usr/bin/env python

from __future__ import print_function

import argparse
import collections
import uuid
import copy
import heapq
import json
import re
import sqlite3
import logging
import os

import numpy as np
import six

import neuroglancer

debug_graph = False
verbose_merging = False


def normalize_edge((id_a, id_b)):
    if id_a > id_b:
        id_a, id_b = id_b, id_a
    return id_a, id_b


class GreedyMulticut(object):
    def __init__(self, combine_edges, edge_priority):
        # Contains (score, edge_map_value) tuple values in heap order.  The
        # edge_map_value is the actual corresponding value in edge_map, not a copy.
        self.edge_heap = []

        # Maps segment_id -> set of segment_id neighbors.
        self.regions = dict()

        # Maps (id_a, id_b) -> edge_map_value=[score, key, edge_object]
        self.edge_map = dict()
        self.combine_edges = combine_edges
        self.edge_priority = edge_priority
        self.num_valid_edges = 0
        self._initialized = False

    def add_edge(self, (id_a, id_b), edge):
        id_a, id_b = normalize_edge((id_a, id_b))
        self.regions.setdefault(id_a, set()).add(id_b)
        self.regions.setdefault(id_b, set()).add(id_a)
        key = (id_a, id_b)
        entry = self.edge_map.get(key, None)
        if entry is not None:
            edge_data = entry[2] = self.combine_edges(entry[0], edge)
            entry[0] = self.edge_priority(edge_data)
        else:
            entry = self.edge_map[key] = [self.edge_priority(edge), key, edge]
            self.num_valid_edges += 1
        if self._initialized:
            self._add_to_heap(entry)

    def _initialize_heap(self):
        if self._initialized:
            return
        for key in self.edge_map:
            entry = self.edge_map[key]
            self._add_to_heap(entry)
        self._initialized = True

    def _add_to_heap(self, entry):
        heapq.heappush(self.edge_heap, (entry[0], entry))

    def remove_edge_from_heap(self, segment_ids):
        """Remove an edge from the heap."""
        self._initialize_heap()
        key = normalize_edge(segment_ids)
        if key in self.edge_map:
            self.edge_map[key][0] = None
            self.num_valid_edges -= 1

    def check_consistency(self):
        self._initialize_heap()
        expected_regions = dict()
        for key, entry in six.viewitems(self.edge_map):
            assert entry[1] == key
            expected_regions.setdefault(key[0], set()).add(key[1])
            expected_regions.setdefault(key[1], set()).add(key[0])

        assert expected_regions == self.regions

        num_valid_edges = 0
        for e in self.edge_heap:
            if self._is_valid_heap_entry(e):
                num_valid_edges += 1
        assert num_valid_edges == self.num_valid_edges

    def merge(self, (id_a, id_b)):
        self._initialize_heap()
        id_a, id_b = normalize_edge((id_a, id_b))
        if (id_a, id_b) not in self.edge_map:
            raise KeyError
        for neighbor in self.regions[id_b]:
            if neighbor == id_a:
                continue
            expired_ids = normalize_edge((neighbor, id_b))
            new_ids = normalize_edge((neighbor, id_a))
            new_edge = self.edge_map.get(new_ids)
            expired_edge = self.edge_map[expired_ids]
            if new_edge is not None:
                edge_data = new_edge[2] = self.combine_edges(new_edge[2], expired_edge[2])
                if new_edge[0] is not None:
                    self.num_valid_edges -= 1
                if expired_edge[0] is not None:
                    self.num_valid_edges -= 1
                self.num_valid_edges += 1
                new_edge[0] = self.edge_priority(edge_data)
                self._add_to_heap(new_edge)
            else:
                self.regions[neighbor].add(id_a)
                self.regions[id_a].add(neighbor)
                self.edge_map[new_ids] = expired_edge
                expired_edge[1] = new_ids
                # No need to add to heap, since score hasn't changed.
            del self.edge_map[expired_ids]
            self.regions[neighbor].remove(id_b)
        del self.regions[id_b]
        self.regions[id_a].remove(id_b)
        del self.edge_map[(id_a, id_b)]
        self.num_valid_edges -= 1

    def _is_valid_heap_entry(self, heap_entry):
        score, entry = heap_entry
        expected_entry = self.edge_map.get(entry[1])
        if entry is not expected_entry or entry[0] is not score:
            return None
        else:
            return entry

    def get_next_edge(self):
        self._initialize_heap()
        while True:
            if self.num_valid_edges == 0:
                return None
            heap_entry = self.edge_heap[0]
            entry = self._is_valid_heap_entry(heap_entry)
            if entry is None:
                heapq.heappop(self.edge_heap)
            else:
                return entry


Edge = collections.namedtuple('Edge', ['segment_ids', 'score', 'position'])


def load_edges(path):
    edges = []
    with open(path, 'r') as f:
        f.readline()
        for line in f:
            parts = line.split(',')
            segment_a = int(parts[0].strip())
            segment_b = int(parts[1].strip())
            score = float(parts[2].strip())
            position = (int(parts[3].strip()), int(parts[4].strip()), int(parts[5].strip()))
            edges.append(Edge(segment_ids=(segment_a, segment_b), score=score, position=position))
    return edges


def load_split_seeds(path):
    with open(path, 'r') as f:
        raw_seeds = json.loads(f.read())
    seeds = collections.OrderedDict()
    for component in raw_seeds:
        seeds.setdefault(component['label'], []).extend(component['supervoxels'])
    return seeds


def build_graph(edges):
    logging.info('Building graph with %d edges', len(edges))

    def combine_edges(a, b):
        return a + b

    def edge_priority(x):
        return x

    greedy_multicut = GreedyMulticut(
        combine_edges=combine_edges,
        edge_priority=edge_priority,
    )
    for edge in edges:
        greedy_multicut.add_edge(edge.segment_ids, edge.score)
    return greedy_multicut


class AgglomerationGraph(object):
    def __init__(self, conn):
        self.conn = conn
        self.agglo_members_cache = dict()
        self.agglo_edges_cache = dict()

    def get_agglo_id(self, supervoxel_id):
        c = self.conn.cursor()
        c.execute('SELECT agglo_id FROM supervoxels WHERE supervoxel_id=?', (int(supervoxel_id), ))
        result = c.fetchone()
        if result is None:
            return supervoxel_id
        else:
            return result[0]

    def get_agglo_members(self, agglo_id):
        result = self.agglo_members_cache.get(agglo_id)
        if result is not None:
            return result
        c = self.conn.cursor()
        c.execute('SELECT supervoxel_id FROM supervoxels WHERE agglo_id=?', (int(agglo_id), ))
        result = [row[0] for row in c.fetchall()]
        self.agglo_members_cache[agglo_id] = result
        return result

    def get_agglo_edges(self, agglo_id):
        result = self.agglo_edges_cache.get(agglo_id)
        if result is not None:
            return result
        c = self.conn.cursor()
        c.execute('SELECT segment_a, segment_b, score, x, y, z FROM edges WHERE agglo_id=?',
                  (int(agglo_id), ))
        result = [
            Edge(segment_ids=(row[0], row[1]), score=row[2], position=(row[3], row[4], row[5]))
            for row in c.fetchall()
        ]
        self.agglo_edges_cache[agglo_id] = result
        return result


def _make_supervoxel_map(graph, split_seeds, need_agglo_ids):
    supervoxel_map = dict()
    agglo_ids = dict()

    for label in [0, 1]:
        for seed in split_seeds[label]:
            supervoxel_id = seed['supervoxel_id']
            if need_agglo_ids:
                agglo_id = graph.get_agglo_id(supervoxel_id)
                if agglo_id == 0:
                    continue
                agglo_ids.setdefault(agglo_id, []).append((label, seed))
            supervoxel_map.setdefault(supervoxel_id, set()).add(label)
    return agglo_ids, supervoxel_map


def do_split(graph, split_seeds, agglo_id=None, supervoxels=None):

    agglo_ids, supervoxel_map = _make_supervoxel_map(graph, split_seeds, need_agglo_ids=agglo_id is None)

    if agglo_id is None:

        agglo_id_counts = {
            agglo_id: sum(z[1]['count'] for z in seeds)
            for agglo_id, seeds in six.viewitems(agglo_ids)
        }

        agglo_id = max(agglo_ids, key=lambda x: agglo_id_counts[x])

        if len(agglo_ids) > 1:
            logging.info('Warning: more than one agglomerated component.  ' +
                         'Choosing component %d with maximum number of seed points.', agglo_id)
            logging.info('agglo_id_counts = %r', agglo_id_counts)

    input_edges = graph.get_agglo_edges(agglo_id)
    if supervoxels is not None:
        input_edges = [x for x in input_edges if x.segment_ids[0] in supervoxels and x.segment_ids[1] in supervoxels]
    graph = build_graph(input_edges)
    if debug_graph:
        graph.check_consistency()

    cur_eqs = neuroglancer.EquivalenceMap()
    logging.info('Agglomerating')
    threshold = float('inf')
    while True:
        entry = graph.get_next_edge()
        if entry is None:
            if verbose_merging:
                logging.info('Stopping because entry is None')
            break
        if entry[0] > threshold:
            if verbose_merging:
                logging.info('Stopping because edge score %r is > threshold %r', entry[0],
                             threshold)
            break
        segment_ids = entry[1]
        seeds_a = supervoxel_map.get(segment_ids[0])
        seeds_b = supervoxel_map.get(segment_ids[1])
        if ((seeds_a is not None and len(seeds_a) > 1) or (seeds_b is not None and len(seeds_b) > 1)
                or (seeds_a is not None and seeds_b is not None and seeds_a != seeds_b)):
            if verbose_merging:
                logging.info('Excluding edge %r because of seeds: %r %r', segment_ids, seeds_a,
                             seeds_b)
            graph.remove_edge_from_heap(segment_ids)
            continue
        if verbose_merging:
            logging.info('Merging %r with score %r', segment_ids, entry[0])
        graph.merge(segment_ids)
        if debug_graph:
            graph.check_consistency()

        new_id = cur_eqs.union(*segment_ids)
        new_seeds = seeds_a or seeds_b
        if new_seeds:
            supervoxel_map[new_id] = new_seeds

    return dict(agglo_id=agglo_id, cur_eqs=cur_eqs, supervoxel_map=supervoxel_map)


def display_split_result(graph, agglo_id, cur_eqs, supervoxel_map, split_seeds, image_url,
                         segmentation_url):

    agglo_members = set(graph.get_agglo_members(agglo_id))
    state = neuroglancer.ViewerState()
    state.layers.append(name='image', layer=neuroglancer.ImageLayer(source=image_url))
    state.layers.append(
        name='original',
        layer=neuroglancer.SegmentationLayer(
            source=segmentation_url,
            segments=agglo_members,
        ),
        visible=False,
    )
    state.layers.append(
        name='isolated-supervoxels',
        layer=neuroglancer.SegmentationLayer(
            source=segmentation_url,
            segments=set(x for x, seeds in six.viewitems(supervoxel_map) if len(seeds) > 1),
        ),
        visible=False,
    )
    state.layers.append(
        name='split',
        layer=neuroglancer.SegmentationLayer(
            source=segmentation_url,
            equivalences=cur_eqs,
            segments=set(cur_eqs[x] for x in agglo_members),
        ))
    for label, component in six.viewitems(split_seeds):
        state.layers.append(
            name='seed%d' % label,
            layer=neuroglancer.PointAnnotationLayer(
                points=[seed['position'] for seed in component],
            ),
        )

    state.show_slices = False
    state.layout = '3d'
    all_seed_points = [
        seed['position'] for component in six.viewvalues(split_seeds) for seed in component
    ]
    state.voxel_coordinates = np.mean(all_seed_points, axis=0)
    state.perspective_zoom = 140
    return state


def _set_viewer_seeds(s, seeds):
    for inclusive in [False, True]:
        layer_name = 'inclusive-seeds' if inclusive else 'exclusive-seeds'
        s.layers[layer_name] = neuroglancer.AnnotationLayer(
            annotation_color='green' if inclusive else 'red',
            annotations=[
                dict(
                    type='point',
                    id=x['id'],
                    point=x['position'],
                    description=str(x['supervoxel_id']),
                ) for x in seeds[inclusive]
            ],
        )


def _get_viewer_seeds(s):
    seeds = [[], []]
    for inclusive in [False, True]:
        layer_name = 'inclusive-seeds' if inclusive else 'exclusive-seeds'
        try:
            layer = s.layers[layer_name]
        except KeyError:
            pass
        for x in layer.annotations:
            seeds[inclusive].append(
                dict(
                    id=x.id,
                    supervoxel_id=int(x.description),
                    position=tuple(map(int, x.point)),
                ))
    return seeds


class ComponentState(object):
    def __init__(self, data=None):
        self.supervoxels = set()
        self.seeds = [[], []]
        if data is not None:
            self.load(data)

    def load(self, data):
        self.supervoxels = set(data['supervoxels'])
        self.seeds = data['seeds']

    def to_json(self):
        return {
            'supervoxels': sorted(self.supervoxels),
            'seeds': self.seeds,
        }


class InteractiveState(object):
    def __init__(self, path):
        self.unused_supervoxels = set()
        self.components = []
        self.path = path
        self.selected_component = None

    def load(self):
        with open(self.path, 'r') as f:
            data = json.load(f)
            self.unused_supervoxels = set(data['unused_supervoxels'])
            self.components = map(ComponentState, data['components'])
            self.selected_component = data['selected_component']

    def initialize(self, supervoxel_ids):
        self.unused_supervoxels = set(supervoxel_ids)
        self.components = []
        self.selected_component = None

    def to_json(self):
        return {
            'unused_supervoxels': sorted(self.unused_supervoxels),
            'components': [x.to_json() for x in self.components],
            'selected_component': self.selected_component,
        }

    def save(self):
        if self.path is None:
            return
        tmp_path = self.path + '.tmp'
        with open(tmp_path, 'w') as f:
            f.write(json.dumps(self.to_json()))
        os.rename(tmp_path, self.path)

    def make_new_component(self):
        c = ComponentState()
        c.supervoxels = self.unused_supervoxels
        self.unused_supervoxels = set()
        self.selected_component = len(self.components)
        self.components.append(c)

    def cycle_selected_component(self, amount):
        if len(self.components) == 0:
            return
        if self.selected_component is None:
            if amount > 0:
                self.selected_component = 0
            else:
                self.selected_component = len(self.components) - 1
        else:
            self.selected_component = (
                self.selected_component + amount + len(self.components)) % len(self.components)

    def add_seed(self, supervoxel_id, position, inclusive):
        if self.selected_component is None:
            return
        c = self.components[self.selected_component]
        c.seeds[inclusive].append(
            dict(
                supervoxel_id=supervoxel_id,
                position=position,
                id=uuid.uuid4().hex))

class CachedSplitResult(object):
    def __init__(self, state, graph, agglo_id):
        self.state = state
        self.graph = graph
        self.agglo_id = agglo_id
        self.reset()

    def reset(self):
        self.selected_component = None
        self.seeds = [[], []]
        self.supervoxels = set()
        self.split_result = None

    def update(self):
        selected_component = self.state.selected_component
        if selected_component is None:
            if self.selected_component is None:
                return False
            self.reset()
            return True
        component = self.state.components[selected_component]
        if selected_component == self.selected_component:
            if self.supervoxels == component.supervoxels:
                if self.seeds == component.seeds:
                    return False
        self.selected_component = self.state.selected_component
        self.seeds = copy.deepcopy(component.seeds)
        self.supervoxels = set(component.supervoxels)
        print('Recomputing split result')
        self.split_result = do_split(
            graph=self.graph, split_seeds=self.seeds, agglo_id=self.agglo_id,
            supervoxels=self.supervoxels)
        print('Done recomputing split result')
        return True


class InteractiveSplitter(object):
    def __init__(self, graph, agglo_id, image_url, segmentation_url, state_path):
        self.graph = graph
        self.agglo_id = agglo_id
        self.image_url = image_url
        self.segmentation_url = segmentation_url
        self.state = InteractiveState(state_path)
        self.cached_split_result = CachedSplitResult(
            state=self.state, graph=self.graph, agglo_id=self.agglo_id)
        self.agglo_members = set(self.graph.get_agglo_members(agglo_id))

        if state_path is not None and os.path.exists(state_path):
            self.state.load()
        else:
            self.state.initialize(self.agglo_members)

        viewer = self.viewer = neuroglancer.Viewer()
        viewer.actions.add('inclusive-seed', self._add_inclusive_seed)
        viewer.actions.add('exclusive-seed', self._add_exclusive_seed)
        viewer.actions.add('next-component', self._next_component)
        viewer.actions.add('prev-component', self._prev_component)
        viewer.actions.add('new-component', self._make_new_component)
        viewer.actions.add('exclude-component', self._exclude_component)
        viewer.actions.add('exclude-all-but-component', self._exclude_all_but_component)

        key_bindings = [
            ['bracketleft', 'prev-component'],
            ['bracketright', 'next-component'],
            ['at:dblclick0', 'exclude-component'],
            ['at:shift+mousedown2', 'exclude-all-but-component'],
            ['at:control+mousedown0', 'inclusive-seed'],
            ['at:shift+mousedown0', 'exclusive-seed'],
            ['enter', 'new-component'],
        ]

        with viewer.txn() as s:
            s.perspective_zoom = 140
            s.layers.append(
                name='image',
                layer=neuroglancer.ImageLayer(source=self.image_url),
            )
            s.layers.append(
                name='original',
                layer=neuroglancer.SegmentationLayer(
                    source=self.segmentation_url,
                    segments=self.agglo_members,
                ),
            )
            s.layers.append(
                name='unused',
                layer=neuroglancer.SegmentationLayer(source=self.segmentation_url,
                                                     ),
                visible=False,
            )
            s.layers.append(
                name='split-result',
                layer=neuroglancer.SegmentationLayer(
                    source=self.segmentation_url,
                    segments=self.agglo_members,
                ),
            )
            s.concurrent_downloads = 256
            self._update_state(s)

        with viewer.config_state.txn() as s:
            s.status_messages['help'] = ('KEYS: ' + ' | '.join('%s=%s' % (key, command)
                                                               for key, command in key_bindings))
            for key, command in key_bindings:
                s.input_event_bindings.viewer[key] = command
                s.input_event_bindings.slice_view[key] = command
                s.input_event_bindings.perspective_view[key] = command
            self._update_config_state(s)

        viewer.shared_state.add_changed_callback(
            lambda: viewer.defer_callback(self._handle_state_changed))

    def _add_inclusive_seed(self, s):
        self._add_seed(s, True)

    def _add_exclusive_seed(self, s):
        self._add_seed(s, False)

    def _exclude_component(self, s):
        if self.state.selected_component is None:
            return

        component = self.state.components[self.state.selected_component]
        supervoxel_id = self._get_mouse_supervoxel(s)

        if supervoxel_id is None:
            return

        self.cached_split_result.update()
        members = set(self.cached_split_result.split_result['cur_eqs'].members(supervoxel_id))
        component.supervoxels = set(x for x in component.supervoxels if x not in members)
        self.state.unused_supervoxels.update(members)
        self._update_view()

    def _exclude_all_but_component(self, s):
        if self.state.selected_component is None:
            return

        component = self.state.components[self.state.selected_component]
        supervoxel_id = self._get_mouse_supervoxel(s)

        if supervoxel_id is None:
            return

        self.cached_split_result.update()
        members = set(self.cached_split_result.split_result['cur_eqs'].members(supervoxel_id))
        new_unused = set(x for x in component.supervoxels if x not in members)
        component.supervoxels = members
        self.state.unused_supervoxels.update(new_unused)
        self._update_view()


    def _make_new_component(self, s):
        self.state.make_new_component()
        self._update_view()

    def _next_component(self, s):
        self.state.cycle_selected_component(1)
        self._update_view()

    def _prev_component(self, s):
        self.state.cycle_selected_component(-1)
        self._update_view()

    def _handle_state_changed(self):
        if self.state.selected_component is None:
            return
        seeds = _get_viewer_seeds(self.viewer.state)
        component = self.state.components[self.state.selected_component]
        if seeds == component.seeds:
            return
        component.seeds = seeds
        with self.viewer.txn() as s:
            self._update_state(s)

    def _get_mouse_supervoxel(self, s):
        supervoxel_id = s.selected_values['original']
        if supervoxel_id is None:
            m = s.selected_values['split-result']
            if m is not None:
                if isinstance(m, neuroglancer.MapEntry):
                    supervoxel_id = m.key
                else:
                    supervoxel_id = m
        if supervoxel_id is None or supervoxel_id == 0:
            return None
        return supervoxel_id

    def _add_seed(self, s, inclusive):
        supervoxel_id = self._get_mouse_supervoxel(s)
        mouse_voxel_coordinates = s.mouse_voxel_coordinates
        if mouse_voxel_coordinates is None or supervoxel_id is None:
            return
        position = tuple(int(x) for x in mouse_voxel_coordinates)
        self.state.add_seed(supervoxel_id, position, inclusive)
        self._update_view()

    def _update_view(self):
        with self.viewer.txn() as s:
            self._update_state(s)
        with self.viewer.config_state.txn() as s:
            self._update_config_state(s)

    def _update_config_state(self, s):
        if self.state.selected_component is None:
            msg = '[No component selected] %d unused supervoxels' % len(
                self.state.unused_supervoxels)
        else:
            selected_component = self.state.selected_component

            msg = '[Component %d/%d] : %d supervoxels, %d connected components, %d unused' % (
                selected_component, len(self.state.components),
                len(self.cached_split_result.supervoxels),
                len(self.cached_split_result.split_result['cur_eqs'].sets()), len(self.state.unused_supervoxels))
        s.status_messages['status'] = msg

    def _update_state(self, s):
        self.cached_split_result.update()
        self.state.save()
        _set_viewer_seeds(s, self.cached_split_result.seeds)

        s.layers['unused'].segments = self.state.unused_supervoxels
        s.layers['original'].segments = self.cached_split_result.supervoxels
        s.layers['split-result'].segments = self.cached_split_result.supervoxels
        split_result = self.cached_split_result.split_result
        if split_result is not None:
            self._show_split_result(
                s,
                cur_eqs=split_result['cur_eqs'],
                supervoxel_map=split_result['supervoxel_map'],
            )
        s.layout = neuroglancer.row_layout([
            neuroglancer.LayerGroupViewer(
                layout='3d',
                layers=['image', 'original', 'unused', 'inclusive-seeds', 'exclusive-seeds']),
            neuroglancer.LayerGroupViewer(
                layout='3d', layers=['image', 'split-result', 'inclusive-seeds',
                                     'exclusive-seeds']),
        ])

    def _show_split_result(self, s, cur_eqs, supervoxel_map):
        split_layer = s.layers['split-result']
        split_layer.equivalences = cur_eqs
        split_layer.segments = set(cur_eqs[x] for x in self.cached_split_result.supervoxels)


def run_batch(args, graph):
    for path in args.split_seeds:
        split_seeds = load_split_seeds(path)
        split_result = do_split(graph=graph, split_seeds=split_seeds, agglo_id=args.agglo_id)
        state = display_split_result(
            graph=graph,
            split_seeds=split_seeds,
            image_url=args.image_url,
            segmentation_url=args.segmentation_url,
            **split_result)
        print('<p><a href="%s">%s</a></p>' % (neuroglancer.to_url(state), path))


def run_interactive(args, graph):
    # Make splitter a global variable so that it is accessible from the
    # interactive `python -i` shell.
    global splitter

    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)

    splitter = InteractiveSplitter(
        graph,
        agglo_id=args.agglo_id,
        image_url=args.image_url,
        segmentation_url=args.segmentation_url,
        state_path=args.state)
    print(splitter.viewer)


def open_graph(path, agglo_id):
    # Check if graph_db is sharded
    graph_db = path
    m = re.match('(.*)@([0-9]+)((?:\..*)?)$', graph_db)
    if m is not None:
        num_shards = int(m.group(2))
        shard = agglo_id % num_shards
        graph_db = m.group(1) + ('-%05d-of-%05d' % (shard, num_shards)) + m.group(3)

    return AgglomerationGraph(sqlite3.connect(graph_db, check_same_thread=False))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()

    ap.add_argument('-v', '--verbose', action='store_true', help='Display verbose log messages.')

    common_ap = argparse.ArgumentParser(add_help=False)
    common_ap.add_argument(
        '--graph-db', required=True, help='Path to sqlite3 database specifying agglomeration graph')
    common_ap.add_argument(
        '--image-url', required=True, help='Neuroglancer data source URL for image')
    common_ap.add_argument(
        '--segmentation-url', required=True, help='Neuroglancer data source URL for segmentation')

    sub_aps = ap.add_subparsers(help='command to run')
    interactive_ap = sub_aps.add_parser(
        'interactive', help='Interactively split an aglomerated component', parents=[common_ap])

    batch_ap = sub_aps.add_parser(
        'batch', help='Split based on pre-specified seed files', parents=[common_ap])

    interactive_ap.add_argument(
        '--agglo-id', type=int, required=True, help='Agglomerated component id to split')
    interactive_ap.add_argument('--split-seeds', help='Path to JSON file specifying split seeds')
    interactive_ap.add_argument('--state', help='Path to JSON state file.')
    interactive_ap.add_argument(
        '-a',
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    interactive_ap.add_argument(
        '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')

    interactive_ap.set_defaults(func=run_interactive)

    batch_ap.add_argument(
        '--split-seeds', nargs='+', help='Path to JSON file specifying split seeds')
    batch_ap.add_argument('--agglo-id', type=int, help='Agglomerated component id to split')
    batch_ap.set_defaults(func=run_batch)

    args = ap.parse_args()

    graph = open_graph(args.graph_db, args.agglo_id)

    if args.verbose:
        logging.basicConfig(level=logging.INFO)

    args.func(args, graph)

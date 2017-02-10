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

from __future__ import absolute_import, print_function

import json

from six import iteritems

from .trackable import CompoundTrackable
from .trackable import TrackableValue
from .trackable import TrackableList
from .trackable import make_trackable

def default_json_encode(obj):
    if isinstance(obj, CompoundTrackable):
        return obj.children
    if isinstance(obj, TrackableValue):
        return obj.value
    return obj

def make_operation_from_state(state, cached_state):
    if isinstance(state, TrackableValue):
        return {'t': 'value', 'value': state.value}, None
    if isinstance(state, CompoundTrackable):
        if cached_state is None:
            cached_state = {}
        children = {}
        for k, v in iteritems(state.children):
            entry = cached_state.get(k)
            if entry is None or entry[0] is not v:
                entry = [v, 0, None]
                cached_state[k] = entry
            elif entry[1] == v.changed.count:
                continue
            # FIXME: handle add and remove
            children[k], entry[2] = make_operation_from_state(v, entry[2])
            entry[1] = v.changed.count
        if not children:
            return None, cached_state
        return {'t': 'compound', 'children': children}, cached_state
    # if isinstance(state, TrackableList):
    #     return {
    #         't': 'list',
    #         'children': [make_operation_from_state(x) for x in state],
    #     }
    raise ValueError('Expected trackable value')


def transform_operation(client_op, server_op):
    """
    Returns the modified client operation to perform on top of server_op.
    """
    if client_op is None:
        return server_op

    if server_op is None:
        return client_op

    # Returns the transformed client_op  so that it occurs after server_op
    client_type = client_op.get('t')
    server_type = server_op.get('t')
    if client_type != server_type:
        raise RuntimeError('Operation type mismatch: client=%r, server=%r' %
                           (client_type, server_type))
    if client_type == 'value':
        # Server op is assumed to have occurred "afterwards"
        # Therefore the client op is ignored.
        return None

    if client_type == 'compound':
        client_children = client_op['children']
        server_children = server_op['children']
        result_children = {}
        for client_k, client_v in iteritems(client_children):
            server_v = server_children.get(client_k)
            # FIXME: support add/remove
            new_op = transform_operation(client_v, server_v)
            if new_op is not None:
                result_children[client_k] = new_op
        for server_k, server_v in iteritems(server_children):
            if server_k not in client_children:
                result_children[server_k] = server_v
        if not result_children:
            return None
        return {'t': 'compound', 'children': result_children}
    raise RuntimeError('invalid op type')

def combine_operations(op_a, op_b):
    if op_a is None:
        return op_b
    if op_b is None:
        return op_a

    a_type = op_a.get('t')
    b_type = op_b.get('t')
    if a_type != b_type:
        raise RuntimeError('Operation type mismatch: a=%r, b=%r' % (a_type, b_type))
    if a_type == 'value':
        return op_b
    if a_type == 'compound':
        a_children = op_a['children']
        b_children = op_b['children']
        result_children = {}
        for a_k, a_v in iteritems(a_children):
            b_v = b_children.get(a_k)
            op = combine_operations(a_v, b_v)
            if op is not None:
                result_children[a_k] = op
        for b_k, b_v in iteritems(b_children):
            if b_k not in a_children:
                result_children[b_k] = b_v
        if not result_children:
            return None
        return {'t': 'compound', 'children': result_children}
    raise RuntimeError('invalid op type')


def make_state_from_operation(context, op):
    t = op['t']
    if t == 'value':
        return make_trackable(context, op['value']), None
    if t == 'compound':
        return apply_operation(CompoundTrackable(context), op, None)
    raise ValueError('unsupported operation type')

def apply_operation(state, op, cached_state):
    t = op['t']
    if t == 'value':
        if not isinstance(state, TrackableValue):
            raise RuntimeError('expected TrackableValue')
        state.value = op.get('value', None)
        return None
    if t == 'compound':
        if not isinstance(state, CompoundTrackable):
            raise RuntimeError('expected CompoundTrackable')
        if cached_state is None:
            cached_state = {}
        for k, v in iteritems(op['children']):
            # FIXME: handle add and remove
            if k not in state:
                child, cache_value = make_state_from_operation(state.changed.context, v)
                state[k] = child
            else:
                child = state[k]
                cache_entry = cached_state.get(k)
                cache_value = apply_operation(child, v, cache_entry and cache_entry[2])
            cached_state[k] = [v, child.changed.count, cache_value]
        return cached_state
    raise RuntimeError('unsupported op type: %r' % (t,))

class ManagedState(object):
    def __init__(self, state):
        self.state = state
        self.operation_log = []
        self.seen_operations = set()
        self.state.changed.add(self._on_state_changed)
        self.clients = set()

        # Operation to transform initial state to current state.
        with state.context.lock:
            self.cumulative_op, self._cached_state = make_operation_from_state(state, None)
            self._cached_state_generation = state.changed.count
            self.operation_log.append((self.cumulative_op, None))

    @property
    def generation(self):
        return len(self.operation_log) - 1

    def add_client(self, client):
        self.clients.add(client)

    def remove_client(self, client):
        self.clients.remove(client)

    def _notify_clients(self):
        # Must be called with lock held
        i = 0
        for client in self.clients:
            try:
                print('calling on_new_operation for client [%d/%d total]' % (i, len(self.clients),))
                i += 1
                client.on_new_operation()
            except:
                import traceback
                traceback.print_exc()

    def _on_state_changed(self, notify=True):
        print('_on_state_changed')
        state = self.state
        with state.context.lock:
            if state.changed.count == self._cached_state_generation:
                return False
            op, self._cached_state = make_operation_from_state(state, self._cached_state)
            self._cached_state_generation = state.changed.count
            self.cumulative_op = combine_operations(self.cumulative_op, op)
            if op is not None:
                self.operation_log.append((op, None))
                if notify:
                    self._notify_clients()
                return True
            return False

    def apply_change(self, state_id, op_id, client_op):
        with self.state.context.lock:
            if op_id in self.seen_operations:
                return
            # Ensure all changes are reflected in the operation log.
            notify = self._on_state_changed(notify=False)

            # Apply the operation.
            # for each operation in log after the specified state_id, need to transform it
            operation_log = self.operation_log
            max_state_id = len(operation_log)
            cur_state_id = state_id + 1
            while cur_state_id < max_state_id:
                client_op = transform_operation(client_op, operation_log[cur_state_id][0])
                if client_op is None:
                    break
                cur_state_id += 1
            self.seen_operations.add(op_id)
            if client_op is not None:
                operation_log.append((client_op, op_id))
                print('adding to operation_log')
                self._cached_state = apply_operation(self.state, client_op, self._cached_state)
                self._cached_state_generation = self.state.changed.count
                self.cumulative_op = combine_operations(self.cumulative_op, client_op)
                self._notify_clients()
                print('notifying clients')
            elif notify:
                self._notify_clients()

    def get_update(self, state_id, op_id_to_skip):
        print('get update: state_id=%r max_state_id=%r, op_to_skip=%r' % (state_id, len(self.operation_log), op_id_to_skip))
        combined_op = None
        operation_log = self.operation_log
        cur_state_id = state_id + 1
        max_state_id = len(operation_log)
        if op_id_to_skip is None:
            op_id_to_skip = False
        while cur_state_id < max_state_id:
            cur_op, op_id = operation_log[cur_state_id]
            if op_id != op_id_to_skip:
                combined_op = combine_operations(combined_op, cur_op)
            print('   cur_op = %r, combined_op = %r' % (cur_op, combined_op))
            cur_state_id += 1
        return combined_op

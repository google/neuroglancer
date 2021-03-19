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

from __future__ import absolute_import

import copy

import six


class EquivalenceMap(object):
    """Union-find data structure"""

    supports_readonly = True

    def __init__(self, existing=None, _readonly=False):
        """Create a new empty union-find structure."""
        if isinstance(existing, EquivalenceMap):
            self._weights = existing._weights.copy()
            self._parents = existing._parents.copy()
            self._prev_next = existing._prev_next.copy()
            self._min_values = existing._min_values.copy()
        else:
            self._weights = {}
            self._parents = {}
            self._prev_next = {}
            self._min_values = {}
            self._readonly = False
            if existing is not None:
                if isinstance(existing, dict):
                    existing = six.viewitems(existing)
                for group in existing:
                    self.union(*group)
        self._readonly = _readonly

    def _get_representative(self, obj):
        """Finds and returns the root of the set containing `obj`."""

        if obj not in self._parents:
            self._parents[obj] = obj
            self._weights[obj] = 1
            self._prev_next[obj] = [obj, obj]
            self._min_values[obj] = obj
            return obj

        path = [obj]
        root = self._parents[obj]
        while root != path[-1]:
            path.append(root)
            root = self._parents[root]

        # compress the path and return
        for ancestor in path:
            self._parents[ancestor] = root
        return root

    def __getitem__(self, obj):
        """Returns the minimum element in the set containing `obj`."""
        if obj not in self._parents:
            return obj
        return self._min_values[self._get_representative(obj)]

    def __iter__(self):
        """Iterates over all elements known to this equivalence map."""
        return iter(self._parents)

    def items(self):
        return six.viewitems(self._parents)

    def keys(self):
        return six.viewkeys(self._parents)

    def clear(self):
        self._weights.clear()
        self._parents.clear()
        self._prev_next.clear()
        self._min_values.clear()

    def union(self, *args):
        """Unions the equivalence classes containing the elements in `*args`."""
        if self._readonly:
            raise AttributeError

        if len(args) == 0:
            return None
        if len(args) == 1:
            return self[args[0]]
        for a, b in zip(args[:-1], args[1:]):
            result = self._union_pair(a, b)
        return result

    def _union_pair(self, a, b):
        a = self._get_representative(a)
        b = self._get_representative(b)
        if a == b:
            return self._min_values[a]
        if self._weights[a] < self._weights[b]:
            a, b = (b, a)

        self._min_values[a] = min(self._min_values[a], self._min_values[b])

        a_links_new = self._prev_next[a]
        a_links_old = tuple(a_links_new)
        b_links_new = self._prev_next[b]
        b_links_old = tuple(b_links_new)

        # We want to splice b's list at the end of a's list

        # Splice beginning of b's list into end of a's list
        b_links_new[0] = a_links_old[0]
        self._prev_next[a_links_old[0]][1] = b

        # Splice end of b's list into end of a's list

        # last element of a's list is set to last element of b's list
        a_links_new[0] = b_links_old[0]
        # fix next pointer for last element of b's list
        self._prev_next[b_links_old[0]][1] = a
        self._weights[a] += self._weights[b]
        self._parents[b] = a
        return self._min_values[a]

    def members(self, x):
        """Yields the members of the equivalence class containing `x`."""
        if x not in self._parents:
            yield x
            return
        cur_x = x
        while True:
            yield cur_x
            cur_x = self._prev_next[cur_x][1]
            if cur_x == x:
                break

    def sets(self):
        """Returns the equivalence classes as a set of sets."""
        sets = {}
        for x in self._parents:
            sets.setdefault(self[x], set()).add(x)
        return frozenset(frozenset(v) for v in six.viewvalues(sets))

    def to_json(self):
        """Returns the equivalence classes a sorted list of sorted lists."""
        sets = self.sets()
        return sorted(sorted(x) for x in sets)

    def __copy__(self):
        """Does not preserve _readonly attribute."""
        return EquivalenceMap(self)

    def __deepcopy__(self, memo):
        """Does not preserve _readonly attribute."""
        result = EquivalenceMap()
        result._parents = copy.deepcopy(self._parents, memo)
        result._weights = copy.deepcopy(self._weights, memo)
        result._prev_next = copy.deepcopy(self._prev_next, memo)
        result._min_values = copy.deepcopy(self._min_values, memo)
        return result

    def copy(self):
        """Returns a copy of the equivalence map."""
        return EquivalenceMap(self)

    def delete_set(self, x):
        """Removes the equivalence class containing `x`."""
        if x not in self._parents:
            return
        members = list(self.members(x))
        for v in members:
            del self._parents[v]
            del self._weights[v]
            del self._prev_next[v]
            del self._min_values[v]

    def isolate_element(self, x):
        """Isolates `x` from its equivalence class."""
        members = list(self.members(x))
        self.delete_set(x)
        self.union(*(v for v in members if v != x))

# coding=utf-8
# @license
# Copyright 2019-2020 Google Inc.
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
"""Wrappers for representing a Neuroglancer coordinate space."""

import collections
import numpy as np

__all__ = []


def export(obj):
    __all__.append(obj.__name__)
    return obj


si_prefixes = {
    'Y': 24,
    'Z': 21,
    'E': 18,
    'P': 15,
    'T': 12,
    'G': 9,
    'M': 6,
    'k': 3,
    'h': 2,
    '': 0,
    'c': -2,
    'm': -3,
    'u': -6,
    'µ': -6,
    'n': -9,
    'p': -12,
    'f': -15,
    'a': -18,
    'z': -21,
    'y': -24,
}

si_units = ['m', 's', 'rad/s', 'Hz']

si_units_with_prefixes = {
    '%s%s' % (prefix, unit): (unit, exponent)
    for (prefix, exponent) in si_prefixes.items() for unit in si_units
}

si_units_with_prefixes[''] = ('', 0)


def parse_unit(scale, unit):
    unit, exponent = si_units_with_prefixes[unit]
    if exponent >= 0:
        return (scale * 10**exponent, unit)
    else:
        return (scale / 10**(-exponent), unit)


@export
class DimensionScale(collections.namedtuple('DimensionScale', ['scale', 'unit'])):
    __slots__ = ()

    def __new__(cls, scale=1, unit=''):
        return super(DimensionScale, cls).__new__(cls, scale, unit)


@export
class CoordinateSpace(object):
    __slots__ = ('names', 'scales', 'units')

    def __init__(self, json=None, names=None, scales=None, units=None):
        if json is None:
            if names is not None:
                self.names = tuple(names)
                scales = np.array(scales, dtype=np.float64)
                if isinstance(units, str):
                    units = tuple(units for _ in names)
                scales_and_units = tuple(
                    parse_unit(scale, unit) for scale, unit in zip(scales, units))
                scales = np.array([s[0] for s in scales_and_units], dtype=np.float64)
                units = tuple(s[1] for s in scales_and_units)
                self.units = units
                self.scales = scales
            else:
                self.names = ()
                self.scales = np.zeros(0, dtype=np.float64)
                self.units = ()
        else:
            if not isinstance(json, dict): raise TypeError
            self.names = tuple(json.keys())
            self.scales = np.array([json[k][0] for k in self.names], dtype=np.float64)
            self.units = tuple(json[k][1] for k in self.names)
        self.scales.setflags(write=False)

    @property
    def rank(self):
        return len(self.names)

    def __getitem__(self, i):
        if isinstance(i, str):
            idx = self.names.index(i)
            return DimensionScale(scale=self.scales[idx], unit=self.units[idx])
        if isinstance(i, slice):
            idxs = range(self.rank)[i]
            return [DimensionScale(scale=self.scales[j], unit=self.units[j]) for j in idxs]
        return DimensionScale(scale=self.scales[i], unit=self.units[i])

    def __repr__(self):
        return 'CoordinateSpace(%r)' % (self.to_json(), )

    def to_json(self):
        d = collections.OrderedDict()
        for name, scale, unit in zip(self.names, self.scales, self.units):
            d[name] = [scale, unit]
        return d

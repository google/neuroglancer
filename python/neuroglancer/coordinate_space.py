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
import re

import numpy as np

__all__ = []


def export(obj):
    __all__.append(obj.__name__)
    return obj


si_prefixes = {
    "Y": 24,
    "Z": 21,
    "E": 18,
    "P": 15,
    "T": 12,
    "G": 9,
    "M": 6,
    "k": 3,
    "h": 2,
    "": 0,
    "c": -2,
    "m": -3,
    "u": -6,
    "µ": -6,
    "n": -9,
    "p": -12,
    "f": -15,
    "a": -18,
    "z": -21,
    "y": -24,
}

si_units = ["m", "s", "rad/s", "Hz"]

si_units_with_prefixes = {
    f"{prefix}{unit}": (unit, exponent)
    for (prefix, exponent) in si_prefixes.items()
    for unit in si_units
}

si_units_with_prefixes[""] = ("", 0)


def parse_unit(scale, unit):
    unit, exponent = si_units_with_prefixes[unit]
    if exponent >= 0:
        return (scale * 10**exponent, unit)
    else:
        return (scale / 10 ** (-exponent), unit)


def parse_unit_and_scale(unit_and_scale: str) -> tuple[float, str]:
    if unit_and_scale == "":
        return (1, "")
    m = re.fullmatch(
        r"/^((?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)?([µa-zA-Z]+)?$", unit_and_scale
    )
    if m is None:
        raise ValueError("Invalid unit", unit_and_scale)
    scale_str = m.group(1)
    if scale_str is None:
        scale = 1.0
    else:
        scale = float(scale_str)

    unit = ""
    unit_str = m.group(2)
    if unit_str is not None:
        unit, exponent = si_units_with_prefixes[unit_str]
        if exponent >= 0:
            scale *= 10**exponent
        else:
            scale /= 10 ** (-exponent)
    return (scale, unit)


@export
class CoordinateArray:
    __slots__ = "_data"

    def __init__(self, json_data=None, labels=None, coordinates=None, mappings=None):
        if mappings is None:
            mappings = dict()
        else:
            mappings = dict(mappings)
        if labels is not None:
            if coordinates is None:
                coordinates = range(len(labels))
            for coordinate, label in zip(coordinates, labels):
                mappings[coordinate] = label
        if json_data is not None:
            if (
                not isinstance(json_data, dict)
                or "coordinates" not in json_data
                or "labels" not in json_data
            ):
                raise ValueError(
                    'Expected object with "coordinates" and "labels" properties'
                )
            coordinates = json_data["coordinates"]
            labels = json_data["labels"]
            for coordinate, label in zip(coordinates, labels):
                mappings[coordinate] = label
        self._data = mappings

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def __repr__(self):
        return repr(self._data)

    def __str__(self):
        return str(self._data)

    def __eq__(self, other):
        if not isinstance(other, CoordinateArray):
            return False
        return self._data == other._data

    def __getitem__(self, k):
        if isinstance(k, str):
            for other_k, other_v in self._data.items():
                if other_k == k:
                    return other_v
            raise KeyError(f"label not found: {k!r}")
        return self._data[k]

    def to_json(self):
        return dict(
            coordinates=list(self._data.keys()), labels=list(self._data.values())
        )


@export
class DimensionScale(
    collections.namedtuple("DimensionScale", ["scale", "unit", "coordinate_array"])
):
    __slots__ = ()

    def __new__(cls, scale=1, unit="", coordinate_array=None):
        return super().__new__(cls, scale, unit, coordinate_array)

    @staticmethod
    def from_json(json):
        if isinstance(json, DimensionScale):
            return json
        if isinstance(json, list):
            if len(json) != 2:
                raise ValueError(f"Expected [scale, unit], but received: {json!r}")
            scale = json[0]
            unit = json[1]
            coordinate_array = None
        else:
            scale = None
            unit = None
            coordinate_array = CoordinateArray(json_data=json)
        return DimensionScale(scale=scale, unit=unit, coordinate_array=coordinate_array)


@export
class CoordinateSpace:
    __slots__ = ("names", "scales", "units", "coordinate_arrays")

    def __init__(
        self, json=None, names=None, scales=None, units=None, coordinate_arrays=None
    ):
        if json is None:
            if names is not None:
                self.names = tuple(names)
                scales = np.array(scales, dtype=np.float64)
                if isinstance(units, str):
                    units = tuple(units for _ in names)
                scales_and_units = tuple(
                    parse_unit(scale, unit) for scale, unit in zip(scales, units)
                )
                scales = np.array([s[0] for s in scales_and_units], dtype=np.float64)
                units = tuple(s[1] for s in scales_and_units)
                if coordinate_arrays is None:
                    coordinate_arrays = tuple(None for x in units)
                else:
                    coordinate_arrays = tuple(coordinate_arrays)
                self.units = units
                self.scales = scales
                self.coordinate_arrays = coordinate_arrays
            else:
                self.names = ()
                self.scales = np.zeros(0, dtype=np.float64)
                self.units = ()
                self.coordinate_arrays = ()
        else:
            if not isinstance(json, dict):
                raise TypeError
            self.names = tuple(json.keys())
            values = tuple(DimensionScale.from_json(v) for v in json.values())
            self.scales = np.array([v.scale for v in values], dtype=np.float64)
            self.units = tuple(v.unit for v in values)
            self.coordinate_arrays = tuple(v.coordinate_array for v in values)
        self.scales.setflags(write=False)

    @property
    def rank(self):
        return len(self.names)

    def __getitem__(self, i):
        if isinstance(i, str):
            idx = self.names.index(i)
            return DimensionScale(
                scale=self.scales[idx],
                unit=self.units[idx],
                coordinate_array=self.coordinate_arrays[idx],
            )
        if isinstance(i, slice):
            idxs = range(self.rank)[i]
            return [
                DimensionScale(
                    scale=self.scales[j],
                    unit=self.units[j],
                    coordinate_array=self.coordinate_arrays[j],
                )
                for j in idxs
            ]
        return DimensionScale(
            scale=self.scales[i],
            unit=self.units[i],
            coordinate_array=self.coordinate_arrays[i],
        )

    def __repr__(self):
        return f"CoordinateSpace({self.to_json()!r})"

    def to_json(self):
        d = {}
        for name, scale, unit, coordinate_array in zip(
            self.names, self.scales, self.units, self.coordinate_arrays
        ):
            if coordinate_array is None:
                d[name] = [scale, unit]
            else:
                d[name] = coordinate_array.to_json()
        return d

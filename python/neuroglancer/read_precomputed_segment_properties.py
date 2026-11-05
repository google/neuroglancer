# @license
# Copyright 2025 Google Inc.
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
"""Reads the Precomputed segment properties format."""

import dataclasses
import json
import typing

import tensorstore as ts


@dataclasses.dataclass
class SegmentProperties:
    id: int
    properties: dict[str, float]


class SegmentPropertySpec(typing.NamedTuple):
    id: str
    type: str
    description: str | None = None
    tag_descriptions: str | None = None


def _get_decoder(prop):
    match prop["type"]:
        case "tags":
            return _tag_decoder(prop["tags"])
        case _:
            return _identity_decoder


def _identity_decoder(x):
    return x


def _tag_decoder(tags: list[str]):
    def decode(x):
        return [tags[i] for i in x]

    return decode


class PrecomputedSegmentPropertiesReader:
    def __init__(self, base_spec: ts.KvStore.Spec | typing.Any) -> None:
        base_spec = ts.KvStore.Spec(base_spec)
        if base_spec.path and not base_spec.path.endswith("/"):
            base_spec.path += "/"
        self.base_spec = base_spec
        self.data = json.loads(ts.KvStore.open(self.base_spec).result()["info"])
        if (
            not isinstance(self.data, dict)
            or self.data.get("@type") != "neuroglancer_segment_properties"
        ):
            raise ValueError("Invalid segment_properties metadata", self.data)
        inline = self.data["inline"]
        self._id_to_index = {int(seg_id): i for i, seg_id in enumerate(inline["ids"])}
        self.properties = {
            prop["id"]: SegmentPropertySpec(
                id=prop["id"],
                type=prop["type"],
                tag_descriptions=prop.get("tag_descriptions"),
                description=prop.get("description"),
            )
            for prop in inline["properties"]
        }
        self._values = {prop["id"]: prop["values"] for prop in inline["properties"]}
        self._decode_property = {
            prop["id"]: _get_decoder(prop) for prop in inline["properties"]
        }

    def __getitem__(self, key: int) -> SegmentProperties:
        idx = self._id_to_index[key]
        return SegmentProperties(
            id=key,
            properties={
                prop_id: self._decode_property[prop_id](self._values[prop_id][idx])
                for prop_id in self.properties
            },
        )

    def __contains__(self, key: int) -> bool:
        return key in self._id_to_index

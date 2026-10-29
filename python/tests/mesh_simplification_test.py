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


"""Geometry validation and negative tests for mesh simplification."""

import os

import numpy as np
import pytest
from neuroglancer import local_volume, test_util, viewer_state

testdata_dir = os.path.join(os.path.dirname(__file__), "..", "..", "testdata", "mesh")


def _decode_mesh(encoded):
    assert encoded is not None and len(encoded) >= 4
    num_vertices = int(np.frombuffer(encoded, dtype="<u4", count=1)[0])
    index_offset = 4 + num_vertices * 12
    assert num_vertices >= 4 and index_offset < len(encoded)
    assert (len(encoded) - index_offset) % 12 == 0
    vertices = np.frombuffer(
        encoded, dtype="<f4", count=num_vertices * 3, offset=4
    ).reshape(-1, 3)
    indices = np.frombuffer(encoded, dtype="<u4", offset=index_offset).reshape(-1, 3)
    return vertices.astype(np.float64), indices


def _assert_closed_mesh(vertices, indices):
    assert np.all(np.isfinite(vertices))
    assert np.all((indices >= 0) & (indices < len(vertices)))
    np.testing.assert_array_equal(np.unique(indices), np.arange(len(vertices)))

    triangles = vertices[indices]
    normals = np.cross(
        triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    )
    assert np.all(np.linalg.norm(normals, axis=1) > 0)

    edges = np.concatenate([indices[:, [0, 1]], indices[:, [1, 2]], indices[:, [2, 0]]])
    unique_edges, counts = np.unique(edges, axis=0, return_counts=True)
    assert np.all(counts == 1)
    np.testing.assert_array_equal(unique_edges, np.unique(edges[:, ::-1], axis=0))
    assert len(vertices) - len(unique_edges) // 2 + len(indices) == 2

    connected = set()
    pending = [0]
    while pending:
        vertex = pending.pop()
        if vertex in connected:
            continue
        connected.add(vertex)
        pending.extend(edges[edges[:, 0] == vertex, 1])
    assert len(connected) == len(vertices)

    volume = np.einsum("ij,ij->", triangles[:, 0], normals) / 6
    assert volume > 0
    return volume


def _surface_distances(points, vertices, indices):
    """Distance from each sample point to the closest triangle."""
    distances = np.full(len(points), np.inf)
    for triangle in vertices[indices]:
        edges = np.roll(triangle, -1, axis=0) - triangle
        normal = np.cross(edges[0], edges[1])
        normal /= np.linalg.norm(normal)
        plane_distance = (points - triangle[0]) @ normal
        projected = points - plane_distance[:, None] * normal
        inside = np.all(
            np.einsum(
                "pec,c->pe",
                np.cross(edges[None, :, :], projected[:, None, :] - triangle),
                normal,
            )
            >= -1e-10,
            axis=1,
        )
        delta = points[:, None, :] - triangle
        edge_fraction = np.clip(
            np.einsum("pec,ec->pe", delta, edges) / np.sum(edges * edges, axis=1),
            0,
            1,
        )
        edge_distance = np.linalg.norm(
            delta - edge_fraction[:, :, None] * edges, axis=2
        ).min(axis=1)
        distances = np.minimum(
            distances, np.where(inside, np.abs(plane_distance), edge_distance)
        )
    return distances


def _assert_simplified_mesh(encoded, reference, max_distance):
    vertices, indices = _decode_mesh(encoded)
    reference_vertices, reference_indices = _decode_mesh(reference)
    volume = _assert_closed_mesh(vertices, indices)
    reference_volume = _assert_closed_mesh(reference_vertices, reference_indices)
    assert volume <= reference_volume + 1e-10
    assert len(indices) < len(reference_indices)

    # Edge collapses retain existing vertices, but their selection and order may
    # depend on floating-point contraction.
    assert np.all(
        np.any(
            np.all(vertices[:, None, :] == reference_vertices[None, :, :], axis=2),
            axis=1,
        )
    )
    for source_vertices, source_indices, target_vertices, target_indices in (
        (vertices, indices, reference_vertices, reference_indices),
        (reference_vertices, reference_indices, vertices, indices),
    ):
        samples = np.concatenate(
            [source_vertices, source_vertices[source_indices].mean(axis=1)]
        )
        assert np.all(
            _surface_distances(samples, target_vertices, target_indices) <= max_distance
        )


@pytest.fixture(scope="module")
def mesh_data():
    data = np.array(
        [
            [[1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2]],
            [[1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2]],
        ],
        dtype=np.uint64,
    ).transpose()
    return np.pad(data, 1, "constant")


def _make_volume(data, max_quadrics_error):
    dimensions = viewer_state.CoordinateSpace(
        names=["x", "y", "z"],
        scales=[1, 1, 1],
        units=["m", "m", "m"],
    )
    return local_volume.LocalVolume(
        data,
        dimensions=dimensions,
        mesh_options=dict(max_quadrics_error=max_quadrics_error),
    )


@pytest.fixture(scope="module")
def unsimplified_volume(mesh_data):
    return _make_volume(mesh_data, max_quadrics_error=-1)


@pytest.mark.parametrize("object_id", [1, 2])
def test_unsimplified_mesh(unsimplified_volume, object_id):
    encoded = unsimplified_volume.get_object_mesh(object_id)
    _assert_closed_mesh(*_decode_mesh(encoded))
    test_util.check_golden_contents(
        os.path.join(testdata_dir, f"simple{object_id}_unsimplified"), encoded
    )


@pytest.mark.parametrize("object_id", [1, 2])
@pytest.mark.parametrize("max_quadrics_error,max_distance", [(1, 1), (1e6, 3)])
def test_simplified_mesh(
    mesh_data, unsimplified_volume, object_id, max_quadrics_error, max_distance
):
    # Allow one voxel of sampled surface error with the default error budget.
    # The aggressive budget may reduce the three-voxel-wide object to a tetrahedron.
    volume = _make_volume(mesh_data, max_quadrics_error)
    _assert_simplified_mesh(
        volume.get_object_mesh(object_id),
        unsimplified_volume.get_object_mesh(object_id),
        max_distance,
    )


@pytest.mark.parametrize("object_id", [1, 2])
def test_historical_simplified_mesh(unsimplified_volume, object_id):
    with open(os.path.join(testdata_dir, f"simple{object_id}"), "rb") as f:
        encoded = f.read()
    _assert_simplified_mesh(
        encoded, unsimplified_volume.get_object_mesh(object_id), max_distance=3
    )


@pytest.mark.parametrize(
    "corruption",
    ["nonfinite", "invalid_index", "degenerate", "open", "winding", "inverted"],
)
def test_invalid_mesh(corruption):
    with open(os.path.join(testdata_dir, "simple1"), "rb") as f:
        vertices, indices = _decode_mesh(f.read())
    indices = indices.copy()
    if corruption == "nonfinite":
        vertices[0, 0] = np.nan
    elif corruption == "invalid_index":
        indices[0, 0] = len(vertices)
    elif corruption == "degenerate":
        indices[0, 0] = indices[0, 1]
    elif corruption == "open":
        indices = indices[:-1]
    elif corruption == "winding":
        indices[0] = indices[0, ::-1]
    elif corruption == "inverted":
        indices = indices[:, ::-1]
    with pytest.raises(AssertionError):
        _assert_closed_mesh(vertices, indices)


@pytest.mark.parametrize("corruption", ["translation", "excessive_error"])
def test_invalid_simplification(unsimplified_volume, corruption):
    with open(os.path.join(testdata_dir, "simple1"), "rb") as f:
        encoded = bytearray(f.read())
    max_distance = 3
    if corruption == "translation":
        vertices, _ = _decode_mesh(encoded)
        vertices[:, 0] += 10
        encoded[4 : 4 + vertices.size * 4] = vertices.astype("<f4").tobytes()
    else:
        max_distance = 0
    with pytest.raises(AssertionError):
        _assert_simplified_mesh(
            encoded, unsimplified_volume.get_object_mesh(1), max_distance
        )


def test_surface_distances():
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float64)
    indices = np.array([[0, 1, 2]])
    points = np.array(
        [[0.25, 0.25, 0], [0.25, 0.25, 1], [-1, 0, 0], [1, 1, 0], [-1, -1, 0]]
    )
    np.testing.assert_allclose(
        _surface_distances(points, vertices, indices),
        [0, 1, 1, np.sqrt(0.5), np.sqrt(2)],
        atol=1e-10,
    )

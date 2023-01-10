import neuroglancer
import numpy as np
import pytest


def test_numpy_data():
    shape = (8, 16, 32)
    data = np.zeros(shape)
    local_volume = neuroglancer.LocalVolume(data)
    assert local_volume.rank == len(shape)
    assert local_volume.shape == shape
    dimensions = neuroglancer.CoordinateSpace(
        names=local_volume.data._default_labels,
        units=local_volume.data._default_units,
        scales=local_volume.data._default_scales)
    assert local_volume.dimensions.to_json() == dimensions.to_json()


def test_tensorstore_defaults():
    ts = pytest.importorskip("tensorstore")
    shape = (8, 16, 32)
    data = ts.open({
        'driver': 'n5',
        'kvstore': {
            'driver': 'memory',
        },
        'metadata': {
            'dataType': 'uint8',
            'dimensions': shape,
        },
        'create': True,
        'delete_existing': True,
      }).result()
    local_volume = neuroglancer.LocalVolume(data)
    assert local_volume.rank == len(shape)
    assert local_volume.shape == shape
    dimensions = neuroglancer.CoordinateSpace(
        names=local_volume.data._default_labels,
        units=local_volume.data._default_units,
        scales=local_volume.data._default_scales)
    assert local_volume.dimensions.to_json() == dimensions.to_json()


def test_tensorstore_features():
    ts = pytest.importorskip("tensorstore")
    shape = (8, 16, 32)
    offset = (2, 4, 8)
    labels = ['x', 'y', '']
    units = ['m', 'm', 'm']
    scales = [1., 1., 0.5]
    data = ts.open({
        'driver': 'n5',
        'kvstore': {
            'driver': 'memory',
        },
        'metadata': {
            'dataType': 'uint8',
            'dimensions': shape,
            'units': units,
            'resolution': scales,
        },
        'transform': {
            'input_labels': labels,
            'input_inclusive_min': offset,
        },
        'create': True,
        'delete_existing': True,
      }).result()
    local_volume = neuroglancer.LocalVolume(data)
    assert local_volume.rank == len(shape)
    assert local_volume.shape == tuple([s-o for s, o in zip(shape, offset)])
    dimensions = neuroglancer.CoordinateSpace(
        names=['x', 'y', 'd2'],
        units=units,
        scales=scales)
    assert local_volume.dimensions.to_json() == dimensions.to_json()

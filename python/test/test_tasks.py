import os.path

import numpy as np

from neuroglancer.pipeline import Storage, Precomputed, DownsampleTask, MeshTask
from neuroglancer.pipeline.task_creation import create_downsampling_task, MockTaskQueue
from neuroglancer import downsample
from test.test_precomputed import create_layer, delete_layer

def test_downsample():
    delete_layer()
    storage, data = create_layer(size=(128,128,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    assert len(pr.info['scales']) == 1
    create_downsampling_task(storage, MockTaskQueue(), downsample_ratio=[2, 2, 1])
    # pr.info now has an outdated copy of the info file
    storage.wait_until_queue_empty()
    pr_new = Precomputed(storage, scale_idx=1)
    assert len(pr_new.info['scales']) == 2
    assert pr_new.info['scales'][1]['size'] == [64,64,64]
    data = downsample.downsample_with_averaging(
        data, factor=[2, 2, 1, 1])
    assert np.all(pr_new[0:64,0:64,0:64] == data)

def test_mesh():
    delete_layer()
    storage, _ = create_layer(size=(64,64,64,1), offset=(0,0,0), layer_type="segmentation")
    pr = Precomputed(storage)
    # create a box ones surrounded by zeroes
    data = np.zeros(shape=(64,64,64,1), dtype=np.uint32)
    data[1:-1,1:-1,1:-1,:] = 1
    pr[0:64,0:64,0:64] = data

    t = MeshTask(chunk_key=storage.get_path_to_file("1_1_1/"),
             chunk_position='0-64_0-64_0-64',
             layer_path=storage.get_path_to_file(""),
             lod=0, simplification=5, segments=[])
    t.execute()
    assert storage.get_file('mesh/1:0:0-64_0-64_0-64') is not None 
    assert list(storage.list_files('mesh/')) == ['1:0:0-64_0-64_0-64']

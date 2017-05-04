import os.path

import numpy as np

from neuroglancer.pipeline import Storage, Precomputed, DownsampleTask, MeshTask, WatershedTask
from neuroglancer.pipeline.task_creation import create_downsampling_task, MockTaskQueue
from neuroglancer import downsample
from test.test_precomputed import create_layer, delete_layer

def test_downsample_segmentation():
    delete_layer()
    storage, data = create_layer(size=(63,64,65,1), layer_type="segmentation")
    pr = Precomputed(storage)
    assert len(pr.info['scales']) == 1

    create_downsampling_task(storage, MockTaskQueue(), downsample_ratio=[1, 2, 3])
    storage.wait()

    pr_new = Precomputed(storage, scale_idx=1)
    assert len(pr_new.info['scales']) == 2
    assert pr_new.info['scales'][1]['size'] == [63,32,21]
    print pr_new.info
    data = downsample.downsample_segmentation(data, factor=[1, 2, 3, 1])
    assert np.all(pr_new[0:63,0:32,0:21] == data[0:63,0:32,0:21])

def test_downsample_image():
    delete_layer()
    storage, data = create_layer(size=(24,25,26,1), layer_type="image")
    pr = Precomputed(storage)
    assert len(pr.info['scales']) == 1
    create_downsampling_task(storage, MockTaskQueue(), downsample_ratio=[3, 1, 26])
    # pr.info now has an outdated copy of the info file
    storage.wait()
    pr_new = Precomputed(storage, scale_idx=1)
    assert len(pr_new.info['scales']) == 2
    assert pr_new.info['scales'][1]['size'] == [8, 25, 1]
    data = downsample.downsample_with_averaging(
        data, factor=[3, 1, 26, 1])
    assert np.all(pr_new[0:8,0:25,0:1] == data)

def test_downsample_affinities():
    delete_layer()
    storage, data = create_layer(size=(62,64,65,3), layer_type="affinities")
    pr = Precomputed(storage)
    assert len(pr.info['scales']) == 1
    create_downsampling_task(storage, MockTaskQueue(), downsample_ratio=[8, 5, 3])
    # pr.info now has an outdated copy of the info file
    storage.wait()
    pr_new = Precomputed(storage, scale_idx=1)
    assert len(pr_new.info['scales']) == 2
    assert pr_new.info['scales'][1]['size'] == [7,12,21]
    data = downsample.downsample_with_averaging(
        data, factor=[8, 5, 3, 1])
    assert np.all(pr_new[0:7,0:12,0:21] == data[0:7,0:12,0:21])

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

def test_watershed():
    delete_layer('affinities')
    storage, data = create_layer(size=(64,64,64,3), layer_type='affinities', layer_name='affinities')

    delete_layer('segmentation')
    storage, data = create_layer(size=(64,64,64,1), layer_type='segmentation', layer_name='segmentation')

    WatershedTask(chunk_position='0-64_0-64_0-64',
                  crop_position='0-64_0-64_0-64',
                  layer_path_affinities='file:///tmp/removeme/affinities',
                  layer_path_segmentation='file:///tmp/removeme/segmentation',
                  high_threshold=0.999987, low_threshold=0.003, merge_threshold=0.3, 
                  merge_size=800, dust_size=800).execute()


def test_real_data():
    return # this is to expensive to be test by travis
    from tqdm import tqdm
    from itertools import product
    storage = Storage('s3://neuroglancer/pinky40_v11/affinitymap-jnet')
    scale = Precomputed(storage).info['scales'][0]
    for x_min in xrange(0, scale['size'][0], 512):
        for y_min in xrange(0, scale['size'][1], 512):
            for z_min in xrange(0, scale['size'][2], 1024):
                x_max = min(scale['size'][0], x_min + 768)
                y_max = min(scale['size'][1], y_min + 768)
                z_max = min(scale['size'][2], z_min + 1024)

                #adds offsets
                x_min += scale['voxel_offset'][0]; x_max += scale['voxel_offset'][0]
                y_min += scale['voxel_offset'][1]; y_max += scale['voxel_offset'][1]
                z_min += scale['voxel_offset'][2]; z_max += scale['voxel_offset'][2]
                WatershedTask(chunk_position='{}-{}_{}-{}_{}-{}'.format(x_min, x_max, y_min, y_max, z_min, z_max),
                  crop_position='128-640_128-640_0-1024',
                  layer_path_affinities='s3://neuroglancer/pinky40_v11/affinitymap-jnet',
                  layer_path_segmentation='s3://neuroglancer/pinky40_v11/chunked_watershed',
                  high_threshold=0.999987, low_threshold=0.003, merge_threshold=0.3, 
                  merge_size=800, dust_size=800).execute()
   
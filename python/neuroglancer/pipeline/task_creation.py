from __future__ import print_function
import copy
from itertools import product
import json
import math
import re
import os

import numpy as np
from tqdm import tqdm

from neuroglancer import downsample_scales, chunks
from neuroglancer.pipeline import Storage, TaskQueue
from neuroglancer.pipeline.tasks import (BigArrayTask, IngestTask,
     HyperSquareTask, MeshTask, MeshManifestTask, DownsampleTask)
from neuroglancer.ingest.volumes import HDF5Volume

def create_ingest_task(storage, task_queue):
    """
    Creates one task for each ingest chunk present in the build folder.
    It is required that the info file is already placed in order for this task
    to run succesfully.
    """
    for filename in tqdm(storage.list_files(prefix='build/')):
        t = IngestTask(
            chunk_path=storage.get_path_to_file('build/'+filename),
            chunk_encoding='npz',
            layer_path=storage.get_path_to_file(''))
        task_queue.insert(t)

def create_bigarray_task(storage, task_queue):
    """
    Creates one task for each bigarray chunk present in the bigarray folder.
    These tasks will convert the bigarray chunks into chunks that ingest tasks are able to understand.
    """
    for filename in tqdm(storage.list_blobs(prefix='bigarray/')):   
        t = BigArrayTask(
            chunk_path=storage.get_path_to_file('bigarray/'+filename),
            chunk_encoding='npz', #npz_uint8 to convert affinites float32 affinties to uint8
            version='{}/{}'.format(storage._path.dataset_name, storage._path.layer_name))
        task_queue.insert(t)

def compute_bigarray_bounding_box(storage):
    """
    There are many versions of bigarray which have subtle differences.
    Given that it is unlikely that we are migrating from the bigarray format to the
    precomputed chunks once, it is unlikely that we will use these methods in the future.
    We decided to write the shape and offset for each 'version' in tasks.py which can
    be computed using this function.
    """
    abs_x_min = abs_y_min = abs_z_min = float('inf')
    abs_x_max = abs_y_max = abs_z_max = 0
    for filename in tqdm(storage.list_files(prefix='bigarray/')):
        match = re.match(r'(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$', filename)
        (_, _, 
        x_min, x_max,
        y_min, y_max,
        z_min, z_max) = match.groups()
        abs_x_min = min(int(x_min), abs_x_min)
        abs_y_min = min(int(y_min), abs_y_min)
        abs_z_min = min(int(z_min), abs_z_min)
        abs_x_max = max(int(x_max), abs_x_max)
        abs_y_max = max(int(y_max), abs_y_max)
        abs_z_max = max(int(z_max), abs_z_max)       
    print('shape', [abs_x_max-abs_x_min+1,
                    abs_y_max-abs_y_min+1,
                    abs_z_max-abs_z_min+1])
    print('offset', [abs_x_min-1, abs_y_min-1, abs_z_min-1])

def compute_build_bounding_box(storage):
    abs_x_min = abs_y_min = abs_z_min = float('inf')
    abs_x_max = abs_y_max = abs_z_max = 0
    chunk_sizes = set()
    for filename in tqdm(storage.list_files(prefix='build/')):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', filename)
        (x_min, x_max,
         y_min, y_max,
         z_min, z_max) = map(int, match.groups())
        abs_x_min = min(int(x_min), abs_x_min)
        abs_y_min = min(int(y_min), abs_y_min)
        abs_z_min = min(int(z_min), abs_z_min)
        abs_x_max = max(int(x_max), abs_x_max)
        abs_y_max = max(int(y_max), abs_y_max)
        abs_z_max = max(int(z_max), abs_z_max)
        chunk_size = (x_max - x_min, y_max - y_min, z_max - z_min)
        chunk_sizes.add(chunk_size)

    shape = [abs_x_max-abs_x_min,
             abs_y_max-abs_y_min,
             abs_z_max-abs_z_min]
    offset = [abs_x_min, abs_y_min, abs_z_min]  
    chunk_size = largest_size(chunk_sizes)
    print('shape=', shape , '; offset=', offset, '; chunk_size=', chunk_size)
    return shape, offset, chunk_size

def get_build_data_type_and_shape(storage):
    for filename in storage.list_files(prefix='build/'):
        arr = chunks.decode_npz(storage.get_file('build/'+filename))
        return arr.dtype.name, arr.shape[3] #num_channels

def create_info_file_from_build(storage, layer_type, resolution=[1,1,1], encoding='raw'):
    assert layer_type == 'image' or layer_type == 'segmentation'
    layer_shape, layer_offset, build_chunk_size = compute_build_bounding_box(storage)
    data_type, num_channels = get_build_data_type_and_shape(storage)
    info = {
        'data_type': data_type,
        'num_channels': num_channels,
        'scales': [], 
        'type': layer_type,
    }
    if layer_type == 'segmentation':
        info['mesh'] = 'mesh'

    neuroglancer_chunk_size = find_closest_divisor(build_chunk_size, closest_to=[64,64,64])
    scale_ratios = downsample_scales.compute_near_isotropic_downsampling_scales(
        size=layer_shape,
        voxel_size=resolution,
        dimensions_to_downsample=[0, 1, 2],
        max_downsampled_size=neuroglancer_chunk_size
    )
    # if the voxel_offset is not divisible by the ratio
    # zooming out will slightly shift the data.
    # imagine the offset is 10
    # the mip 1 will have an offset of 5
    # the mip 2 will have an offset of 2 instead of 2.5 meaning that it will he half a pixel to the left
    for ratio in scale_ratios:
        downsampled_resolution = map(int, (resolution * np.array(ratio)))
        scale = {  
          'chunk_sizes': [ neuroglancer_chunk_size ],
          'encoding': encoding, 
          'key': '_'.join(map(str, downsampled_resolution)),
          'resolution': downsampled_resolution,
          'size': map(int, np.ceil(np.array(layer_shape) / ratio)),
          'voxel_offset': map(int, layer_offset /  np.array(ratio)),
        }
        info['scales'].append(scale)

    storage.put_file('info', content=json.dumps(info))

def find_closest_divisor(to_divide, closest_to):
    def find_closest(td,ct):
        min_distance = td
        best = td
        for x in divisors(td):
            if abs(x-ct) < min_distance:
                min_distance = abs(x-ct)
                best = x
        return best
    return [find_closest(td,ct) for td, ct in zip(to_divide,closest_to)]

def divisors(n):
    for i in xrange(1, int(math.sqrt(n) + 1)):
        if n % i == 0:
            yield i
            if i*i != n:
                yield n / i

def largest_size(sizes):
    x = y = z = 0
    for size in sizes:
        x =  max(x, size[0])
        y =  max(y, size[1])
        z =  max(z, size[2])
    return [x,y,z]

def create_downsampling_task(storage, task_queue, downsample_ratio=[2, 2, 1]):
    # update info with new scale
    info = json.loads(storage.get_file('info'))
    next_scale = compute_next_scale(info['scales'][-1], downsample_ratio)
    info['scales'].append(next_scale)
    storage.put_file(file_path='info', content=json.dumps(info))
    storage.wait_until_queue_empty()

    # create tasks based on the new scale
    for filename in iterate_over_chunks(next_scale):
        t = DownsampleTask(
           chunk_path=storage.get_path_to_file(os.path.join(next_scale['key'],filename)),
           layer_path=storage.get_path_to_file(''))
        task_queue.insert(t)

def compute_next_scale(old_scale, downsample_ratio):
    next_scale = copy.deepcopy(old_scale)
    next_scale['resolution'] = [ r*v  for r,v in zip(next_scale['resolution'], downsample_ratio) ]
    next_scale['key'] = '_'.join(map(str,next_scale['resolution']))
    next_scale['voxel_offset'] = [ r/v  for r,v in zip(next_scale['voxel_offset'], downsample_ratio)]
    next_scale['size'] = [ r/v  for r,v in zip(next_scale['size'], downsample_ratio)]
    return next_scale

def iterate_over_chunks(scale):
    xyzranges = ( xrange(0, vs, bcs) for vs, bcs in zip(scale['size'], scale['chunk_sizes'][0]) )
    for x_min, y_min, z_min in tqdm(product(*xyzranges)):
        x_max = min(scale['size'][0], x_min + scale['chunk_sizes'][0][0])
        y_max = min(scale['size'][1], y_min + scale['chunk_sizes'][0][1])
        z_max = min(scale['size'][2], z_min + scale['chunk_sizes'][0][2])

        #adds offsets
        x_min += scale['voxel_offset'][0]; x_max += scale['voxel_offset'][0]
        y_min += scale['voxel_offset'][1]; y_max += scale['voxel_offset'][1]
        z_min += scale['voxel_offset'][2]; z_max += scale['voxel_offset'][2]
        yield '{}-{}_{}-{}_{}-{}'.format(
            x_min, x_max, y_min, y_max, z_min, z_max)


def create_hypersquare_tasks(storage, task_queue, bucket_name, path_from_bucket):
    for filename in tqdm(storage.list_files(prefix=path_from_bucket)):
        if '/0.jpg' in filename and 'Volume' in filename: #TODO this has to be reworked
            t = HyperSquareTask(
                chunk_path=storage.get_path_to_file('hypersquare/'+filename),
                chunk_encoding='npz',
                version='{}/{}'.format(storage._path.dataset_name, storage._path.layer_name),
                layer_path=storage.get_path_to_file(''))
            task_queue.insert(t)

def upload_build_chunks(storage, volume, offset=[0, 0, 0], build_chunk_size=[1024,1024,128]):
    xyzranges = ( xrange(0, vs, bcs) for vs, bcs in zip(volume.shape, build_chunk_size) )
    for x_min, y_min, z_min in tqdm(product(*xyzranges)):
        x_max = min(volume.shape[0], x_min + build_chunk_size[0])
        y_max = min(volume.shape[1], y_min + build_chunk_size[1])
        z_max = min(volume.shape[2], z_min + build_chunk_size[2])
        chunk = volume[x_min:x_max, y_min:y_max, z_min:z_max]

        #adds offsets
        x_min += offset[0]; x_max += offset[0]
        y_min += offset[1]; y_max += offset[1]
        z_min += offset[2]; z_max += offset[2]
        filename = 'build/{}-{}_{}-{}_{}-{}'.format(
            x_min, x_max, y_min, y_max, z_min, z_max)
        storage.put_file(filename, chunks.encode_npz(chunk))

class MockTaskQueue():
    def insert(self, task):
        task.execute()
        del task

def ingest_hdf5_example():
    dataset_path='gs://neuroglancer/test_v0'
    task_queue = MockTaskQueue()
    offset = [0,0,0]
    resolution=[6,6,30]
    #ingest image
    layer_type = 'image'
    volume =  HDF5Volume('/usr/people/it2/snemi3d/image.h5', layer_type)
    storage = Storage(dataset_path+'/image', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage, layer_type, resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)


    #ingest segmentation
    layer_type = 'segmentation'
    volume =  HDF5Volume('/usr/people/it2/snemi3d/human_labels.h5', layer_type)
    storage = Storage(dataset_path+'/segmentation', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage, layer_type, resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)
    t = MeshTask(chunk_key=dataset_path+'/segmentation/6_6_30',
             chunk_position='0-1024_0-1024_0-51',
             layer_path=dataset_path+'/segmentation',
             lod=0, simplification=5, segments=[])
    task_queue.insert(t)
    t = MeshTask(chunk_key=dataset_path+'/segmentation/6_6_30',
             chunk_position='0-1024_0-1024_50-100',
             layer_path=dataset_path+'/segmentation',
             lod=0, simplification=5, segments=[])
    task_queue.insert(t)
    t = MeshManifestTask(layer_path=dataset_path+'/segmentation',
                     lod=0).execute()
    task_queue.insert(t)

    #ingest affinities
    # HDF5Volume does some type convertion when affinities are specified as layer type
    # but neuroglancer only has image or segmentation layer types
    volume =  HDF5Volume('/usr/people/it2/snemi3d/affinities.h5', layer_type='affinities')
    storage = Storage(dataset_path+'/affinities', n_threads=0)
    upload_build_chunks(storage, volume, offset)
    create_info_file_from_build(storage, layer_type='image',
        resolution=resolution, encoding='raw')
    create_ingest_task(storage, task_queue)
    create_downsampling_task(storage, task_queue)

    
if __name__ == '__main__':   
    # create_hypersquare_tasks('zfish_v0','segmentation', 'zfish', 'all_7/hypersquare/')
    # create_info_file_from_build(dataset_name='zfish_v0',
    #                             layer_name='segmentation',
    #                             layer_type='segmentation',
    #                             resolution=[5,5,45])
    # create_ingest_task('zfish_v0','segmentation')

    # create_hypersquare_tasks('e2198_v0','image','e2198_compressed',')
    # create_info_file_from_build(dataset_name='e2198_v0',
                                # layer_name='image',
                                # layer_type='image',
                                # resolution=[17,17,23])
    # create_ingest_task('e2198_v0','image')
    ingest_hdf5_example()
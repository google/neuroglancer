from __future__ import print_function
import json
import math
import re
from itertools import product

import numpy as np
from tqdm import tqdm

from neuroglancer import downsample_scales, chunks
from neuroglancer.ingest.base import Storage
from neuroglancer.ingest.tasks import TaskQueue, BigArrayTask, IngestTask, HyperSquareTask, MeshTask, MeshManifestTask
from neuroglancer.ingest.volumes import HDF5Volume

def create_ingest_task(dataset_name, layer_name):
    """
    Creates one task for each ingest chunk present in the build folder.
    It is required that the info file is already placed in order for this task
    to run succesfully.
    """
    tq = TaskQueue()
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    for blob in tqdm(storage._bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name,layer_name))):
        t = IngestTask(
            chunk_path='gs://neuroglancer/'+blob.name,
            chunk_encoding='npz',
            info_path='gs://neuroglancer/{}/{}/info'.format(dataset_name,layer_name))
        t.execute()
        # tq.insert(t)

def create_bigarray_task(dataset_name, layer_name):
    """
    Creates one task for each bigarray chunk present in the bigarray folder.
    These tasks will convert the bigarray chunks into chunks that ingest tasks are able to understand.
    """
    tq = TaskQueue()
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    for blob in tqdm(storage._bucket.list_blobs(prefix='{}/{}/bigarray/'.format(dataset_name, layer_name))):
        name = blob.name.split('/')[-1]
        if name == 'config.json':
            continue       
        t = BigArrayTask(
            chunk_path='gs://neuroglancer/'+blob.name,
            chunk_encoding='npz_uint8', #_uint8 for affinites
            version='{}/{}'.format(dataset_name,layer_name))
        tq.insert(t)

def compute_bigarray_bounding_box(dataset_name, layer_name):
    """
    There are many versions of bigarray which have subtle differences.
    Given that it is unlikely that we are migrating from the bigarray format to the
    precomputed chunks once, it is unlikely that we will use these methods in the future.
    We decided to write the shape and offset for each 'version' in tasks.py which can
    be computed using this function.
    """
    abs_x_min = abs_y_min = abs_z_min = float('inf')
    abs_x_max = abs_y_max = abs_z_max = 0
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    for blob in tqdm(storage._bucket.list_blobs(prefix='{}/{}/bigarray/'.format(dataset_name, layer_name))):
        name = blob.name.split('/')[-1]
        if name == 'config.json':
            continue
        full_path = 'gs://neuroglancer/'+blob.name
        match = re.match(r'^.*/([^//]+)/([^//]+)/bigarray/(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$', full_path)
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

def compute_build_bounding_box(dataset_name, layer_name):
    abs_x_min = abs_y_min = abs_z_min = float('inf')
    abs_x_max = abs_y_max = abs_z_max = 0
    chunk_sizes = set()
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    for blob in tqdm(storage._bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name))):
        match = re.match(r'^.*/(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', blob.name)
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

def get_build_data_type_and_shape(dataset_name, layer_name):
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    for blob in storage._bucket.list_blobs(prefix='{}/{}/build/'.format(dataset_name, layer_name)):
        arr = chunks.decode_npz(blob.download_as_string())
        return arr.dtype.name, arr.shape[3] #num_channels

def create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=[1,1,1], encoding="raw"):
    assert layer_type == "image" or layer_type == "segmentation"
    layer_shape, layer_offset, build_chunk_size = compute_build_bounding_box(dataset_name, layer_name)
    data_type, num_channels = get_build_data_type_and_shape(dataset_name, layer_name)
    info = {
        "data_type": data_type,
        "num_channels": num_channels,
        "scales": [], 
        "type": layer_type,
    }
    if layer_type == "segmentation":
        info['mesh'] = "mesh"

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
          "chunk_sizes": [ neuroglancer_chunk_size ],
          "encoding": encoding, 
          "key": "_".join(map(str, downsampled_resolution)),
          "resolution": downsampled_resolution,
          "size": map(int, np.ceil(np.array(layer_shape) / ratio)),
          "voxel_offset": map(int, layer_offset /  np.array(ratio)),
        }
        info["scales"].append(scale)

    print (info)
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=True)
    storage.add_file(
        filename='info',
        content=json.dumps(info)
    )
    storage.flush('')

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


def create_hypersquare_tasks(dataset_name, layer_name, bucket_name, path_from_bucket):
    tq = TaskQueue()
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
    bucket = storage._client.get_bucket(bucket_name)
    for blob in tqdm(bucket.list_blobs(prefix=path_from_bucket)):
        if '/0.jpg' in blob.name and 'Volume' in blob.name:
            t = HyperSquareTask(
                chunk_path='gs://{}/{}'.format(bucket_name, blob.name),
                chunk_encoding='npz',
                version='{}/{}'.format(dataset_name, layer_name),
                info_path='gs://neuroglancer/{}/{}/info'.format(dataset_name,layer_name))
            # tq.insert(t)
            t.execute()

def upload_build_chunks(dataset_name, layer_name, volume, offset=[0, 0, 0], build_chunk_size=[1024,1024,128]):
    storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
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
        filename = "{}-{}_{}-{}_{}-{}".format(
            x_min, x_max, y_min, y_max, z_min, z_max)
        storage.add_file(filename, chunks.encode_npz(chunk))
    storage.flush('build/')


def ingest_hdf5_example():
    dataset_name = "snemi3d_v0"
    offset = [128,128,128]
    resolution=[6,6,30]
    #ingest image
    layer_name = "image"
    layer_type = "image"
    volume =  HDF5Volume('/usr/people/it2/snemi3d/image.h5', layer_type)
    upload_build_chunks(dataset_name, layer_name, volume, offset)
    create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="jpeg")
    create_ingest_task(dataset_name, layer_name)

    #ingest segmentation
    layer_name = "segmentation"
    layer_type = "segmentation"
    volume =  HDF5Volume('/usr/people/it2/snemi3d/human_labels.h5', layer_type)
    upload_build_chunks(dataset_name, layer_name, volume, offset)
    create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="raw")
    create_ingest_task(dataset_name, layer_name)

    #ingest affinities
    # HDF5Volume does some type convertion when affinities are specified as layer type
    # but neuroglancer only has image or segmentation layer types
    layer_name = "affinities"
    layer_type = "image"
    volume =  HDF5Volume('/usr/people/it2/snemi3d/affinities.h5', layer_type='affinities') 
    upload_build_chunks(dataset_name, layer_name, volume, offset)
    create_info_file_from_build(dataset_name, layer_name, layer_type, resolution=resolution, encoding="raw")
    create_ingest_task(dataset_name, layer_name)

    MeshTask(chunk_key="gs://neuroglancer/snemi3d_v0/segmentation/6_6_30",
             chunk_position="0-1024_0-1024_0-51",
             info_path="gs://neuroglancer/snemi3d_v0/segmentation/info", 
             lod=0, simplification=5, segments=[]).execute()
    MeshTask(chunk_key="gs://neuroglancer/snemi3d_v0/segmentation/6_6_30",
             chunk_position="0-1024_0-1024_50-100",
             info_path="gs://neuroglancer/snemi3d_v0/segmentation/info", 
             lod=0, simplification=5, segments=[]).execute()
    MeshManifestTask(info_path="gs://neuroglancer/snemi3d_v0/segmentation/info",
                     lod=0).execute()
    
if __name__ == '__main__':   
    # create_hypersquare_tasks("zfish_v0","segmentation", "zfish", "all_7/hypersquare/")
    # create_info_file_from_build(dataset_name="zfish_v0",
    #                             layer_name="segmentation",
    #                             layer_type="segmentation",
    #                             resolution=[5,5,45])
    # create_ingest_task("zfish_v0","segmentation")

    # create_hypersquare_tasks("e2198_v0","image","e2198_compressed","")
    # create_info_file_from_build(dataset_name="e2198_v0",
    #                             layer_name="image",
    #                             layer_type="image",
    #                             resolution=[17,17,23])
    # create_ingest_task("e2198_v0","image")
    # ingest_hdf5_example()

    
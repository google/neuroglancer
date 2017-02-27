from __future__ import print_function

from tqdm import tqdm

from neuroglancer.ingest.lib import Storage
from neuroglancer.ingest.tasks import TaskQueue, BigArrayTask, IngestTask

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
        tq.insert(t)

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
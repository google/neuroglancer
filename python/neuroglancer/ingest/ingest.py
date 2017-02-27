"""Neuroglancer Cloud Ingest"""

import json
from itertools import product

import numpy as np
from tqdm import tqdm

from neuroglancer import downsample_scales, chunks
from neuroglancer.ingest.tasks import IngestTask, TaskQueue
from neuroglancer.ingest.lib import  Storage
from neuroglancer.ingest.volumes import HDF5Volume

PROCESSING_CHUNK = (1024, 1024, 128)

class Runner(object):

    def __init__(self, volume, dataset_name, layer_name):
        self._encoding = "npz"
        self._chunk_size = np.array(PROCESSING_CHUNK) #This refers to the volume that will be process by each digest call
        self._neuroglancer_chunk_size = np.array([64,64,64]) #This refers to the chunk sizes neuroglancer will use
        self._volume = volume
        self._dataset_name = dataset_name
        self._layer_name = layer_name
        self._storage = Storage(dataset_name=dataset_name, layer_name=layer_name, compress=False)
        self._queue = TaskQueue()
        self._tasks = []
        self.upload_info()
        self.upload_chunks()

    def flush_tasks(self):
        for task in self._tasks:
            self._queue.insert(task)
        self._tasks = []

    def upload_info(self):
        info = {
            "data_type": str(self._volume.data_type),
            "num_channels": self._volume.num_channels,
            "scales": [], 
            "type": self._volume.layer_type,
        }
        if self._volume.mesh:
          info['mesh'] = "mesh"

        scale_ratio = downsample_scales.compute_near_isotropic_downsampling_scales(
            size=self._volume.shape,
            voxel_size=self._volume.resolution,
            dimensions_to_downsample=[0, 1, 2],
            max_downsampled_size=np.max(self._volume.shape / self._chunk_size * self._neuroglancer_chunk_size)
        )

        for ratio in scale_ratio:
            downsampled_resolution = map(int, (self._volume.resolution * np.array(ratio)))
            scale = {  
              "chunk_sizes": [ map(int,self._neuroglancer_chunk_size) ],
              "encoding": self._volume.encoding, 
              "key": "_".join(map(str, downsampled_resolution)),
              "resolution": downsampled_resolution,
              "size": map(int, np.ceil(np.array(self._volume.shape) / ratio)),
              "voxel_offset": [0, 0, 0],
            }
            info["scales"].append(scale)

        self._storage.add_file(
            filename='info',
            content=json.dumps(info)
        )
        self._storage.flush('')

    def upload_chunks(self):
        xyzranges = ( xrange(0, vs, cs) for vs, cs in zip(self._volume.shape, self._chunk_size) )
        i = 0
        for x_min, y_min, z_min in tqdm(product(*xyzranges)):
            x_max = min(self._volume.shape[0], x_min + self._chunk_size[0])
            y_max = min(self._volume.shape[1], y_min + self._chunk_size[1])
            z_max = min(self._volume.shape[2], z_min + self._chunk_size[2])    
            chunk = self._volume[x_min:x_max,
                                 y_min:y_max,
                                 z_min:z_max]

            filename = "{}-{}_{}-{}_{}-{}".format(
                x_min, x_max, y_min, y_max, z_min, z_max)
            if self._encoding == "npz":
                encoded = chunks.encode_npz(chunk)
            else:
                raise NotImplemented
            self._storage.add_file(filename, encoded)

            i += 1
            if i and i % 10 == 0:
                self._storage.flush('build/')
                self.flush_tasks()
            task = IngestTask(
                chunk_path = "gs://neuroglancer/{}/{}/build/{}".format(self._dataset_name, self._layer_name, filename),
                chunk_encoding = "npz",
                info_path = "gs://neuroglancer/{}/{}/info".format(self._dataset_name, self._layer_name)
            )
            self._tasks.append(task)

        self._storage.flush('build/')
        self.flush_tasks()
  
if __name__ == '__main__':
    v =  HDF5Volume('/usr/people/it2/snemi3d/image.h5', layer_type='image')
    Runner(v, 'snemi3dtest_v0', 'image')
    v =  HDF5Volume('/usr/people/it2/snemi3d/human_labels.h5', layer_type='segmentation')
    Runner(v, 'snemi3dtest_v0', 'segmentation')
    v =  HDF5Volume('/usr/people/it2/snemi3d/affinities.h5', layer_type='affinities')
    Runner(v, 'snemi3dtest_v0', 'affinities')

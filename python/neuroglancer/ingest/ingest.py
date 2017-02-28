#!/usr/bin/python

"""Neuroglancer Cloud Ingest"""

import argparse
import json
import numpy as np
from itertools import product
from neuroglancer import downsample_scales
from tqdm import tqdm

from tasks import Task, TaskQueue
from base import  BUCKET_NAME, QUEUE_NAME, PROJECT_NAME, Storage
from neuroglancer import chunks
from volumes import HDF5Volume, DVIDVolume

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
        self._queue = TaskQueue(PROJECT_NAME, QUEUE_NAME)
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

        if self._volume.layer_type == "image":
            encoding = "jpeg"
        else:
            encoding = "raw"

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
              "encoding": encoding, 
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
        tasks = []
        for x_min_in, y_min_in, z_min_in in tqdm(product(*xyzranges)):

            x_min_out = max(0, x_min_in - 1)
            y_min_out = max(0, y_min_in - 1)
            z_min_out = max(0, z_min_in - 1)
            x_max_in = min(self._volume.shape[0], x_min_in + self._chunk_size[0])
            y_max_in = min(self._volume.shape[1], y_min_in + self._chunk_size[1])
            z_max_in = min(self._volume.shape[2], z_min_in + self._chunk_size[2])
            x_max_out = min(self._volume.shape[0], x_max_in + 1)
            y_max_out = min(self._volume.shape[1], y_max_in + 1)
            z_max_out = min(self._volume.shape[2], z_max_in + 1)

            pad_xmin = 1 if x_min_in == x_min_out else 0
            pad_ymin = 1 if y_min_in == y_min_out else 0
            pad_zmin = 1 if z_min_in == z_min_out else 0
            pad_xmax = -1 if x_max_in == x_max_out else x_max_out - x_min_out + 1
            pad_ymax = -1 if y_max_in == y_max_out else y_max_out - y_min_out + 1
            pad_zmax = -1 if z_max_in == z_max_out else z_max_out - z_min_out + 1

            pad_shape_xmax = 1 if x_max_in == x_max_out else 0
            pad_shape_ymax = 1 if y_max_in == y_max_out else 0
            pad_shape_zmax = 1 if z_max_in == z_max_out else 0
            pad_shape_xmin = 1 if x_min_in == x_min_out else 0
            pad_shape_ymin = 1 if y_min_in == y_min_out else 0
            pad_shape_zmin = 1 if z_min_in == z_min_out else 0

            chunk = np.zeros(shape=(x_max_out - x_min_out + pad_shape_xmax + pad_shape_xmin,
                                    y_max_out - y_min_out + pad_shape_ymax + pad_shape_ymin,
                                    z_max_out - z_min_out + pad_shape_zmax + pad_shape_zmin))
            chunk[pad_xmin:pad_xmax,
                  pad_ymin:pad_ymax,
                  pad_zmin:pad_zmax
                  ] = self._volume[x_min_out:x_max_out,
                                   y_min_out:y_max_out,
                                   z_min_out:z_max_out]


            filename = "{}-{}_{}-{}_{}-{}".format(x_min_in, x_max_in,
                                                  y_min_in, y_max_in,
                                                  z_min_in, z_max_in)
            if self._encoding == "npz":
                encoded = chunks.encode_npz(chunk)
            else:
                raise NotImplemented
            self._storage.add_file(filename, encoded)

            i += 1
            if i and i % 10 == 0:
                self._storage.flush('build/')
                self.flush_tasks()

            task = Task()
            task.chunk_path = filename
            task.chunk_encoding = "npz"
            task.info_path = "{}/{}/info".format(self._dataset_name, self._layer_name)
            self._tasks.append(task)

        self._storage.flush('build/')
        self.flush_tasks()
  
if __name__ == '__main__':
    v =  DVIDVolume()
    Runner(v, 'zfish_v0', 'image')

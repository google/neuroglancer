from time import sleep
from google.cloud import storage
import json
import re
import numpy as np
import itertools
from tqdm import tqdm
from tasks import TaskQueue, Task
from neuroglancer import chunks
from mesher import Mesher
from base import Storage, QUEUE_NAME, PROJECT_NAME

class Runner(object):
    def __init__(self, task):
        self._task = task
        self._dataset_name, self._layer_name = self.get_names()
        self._storage = Storage(dataset_name=self._dataset_name, layer_name=self._layer_name)
        self._info = self.get_info()
        self._data = self.get_data()


        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)', self._task.chunk_path)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())

        for scale in self._info["scales"][::-1]:
            for chunk_size in scale['chunk_sizes']:
                for encoded, filename in self.generate_chunks(scale, chunk_size):
                    self._storage.add_file(filename, encoded)

            self._storage.flush(scale['key'])

        self.mesh()
         
    def get_names(self):
        match = re.match(r'^([^//]+)/([^//]+)/info$', self._task.info_path)
        return match.groups()

    def get_info(self):
        info_string = self._storage.get_blob(
                '{}/{}/info'.format(self._dataset_name, self._layer_name) \
            ).download_as_string()
        return json.loads(info_string)

    def get_data(self):
        string_data = self._storage.get_blob(
            '{}/{}/build/{}'.format(self._dataset_name, self._layer_name, self._task.chunk_path)) \
        .download_as_string()
        if not string_data:
            raise Exception("Download of data failed")
        if self._task.chunk_encoding == 'npz':
          data = chunks.decode_npz(string_data)
        else:
          raise NotImplemented(self._task.chunk_encoding)

        if len(data.shape) == 4 and data.shape[0] > 1:       
            data = np.cast[np.float32](data)

        data = data.astype(self._info["data_type"])
        return np.squeeze(data,axis=0)

    def generate_chunks(self, scale, chunk_size):
        data = self._data[1:-1,1:-1,1:-1] #TODO make sure this is a view and we are not copying data
        
        downsample_ratio = np.array(scale["resolution"]) / np.array(self._info['scales'][0]['resolution'])
        x_stride, y_stride, z_stride = map(int, downsample_ratio)
        volume_size = data.shape / downsample_ratio
        n_chunks = np.array(volume_size) / np.array(chunk_size).astype(np.float32)
        n_chunks = np.ceil(n_chunks).astype(np.uint32)
        (x_chunk_size, y_chunk_size, z_chunk_size) = chunk_size
        every_xyz = itertools.product(*list(map(xrange, n_chunks)))

        for x,y,z in every_xyz:
            chunk = data[
                x * x_chunk_size * x_stride : (x+1) * x_chunk_size * x_stride : x_stride,
                y * y_chunk_size * y_stride : (y+1) * y_chunk_size * y_stride : y_stride,
                z * z_chunk_size * z_stride : (z+1) * z_chunk_size * z_stride : z_stride]

            # Column major vs row major magic required for this to work
            chunk = np.swapaxes(chunk,0,2)
            if scale["encoding"] == "jpeg":
                encoded = chunks.encode_jpeg(chunk)
                content_type='image/jpeg',
            elif scale["encoding"] == "npz":
                encoded = chunks.encode_npz(chunk)
                content_type = 'application/octet-stream'
            elif scale["encoding"] == "raw":
                encoded = chunks.encode_raw(chunk)
                content_type = 'application/octet-stream'
            else:
                raise NotImplemented

            filename = '{}-{}_{}-{}_{}-{}'.format(
              x * x_chunk_size + self._xmin / downsample_ratio[0], #xmin
              min((x + 1) * x_chunk_size + self._xmin / downsample_ratio[0], scale['size'][0]),    #xmax
              y * y_chunk_size + self._ymin / downsample_ratio[1], #ymin
              min((y + 1) * y_chunk_size + self._ymin / downsample_ratio[1], scale['size'][1]),    #ymax
              z * z_chunk_size + self._zmin / downsample_ratio[2], #zmin
              min((z + 1) * z_chunk_size + self._zmin / downsample_ratio[2], scale['size'][2])     #zmax
            ) 

            yield encoded, filename

    def mesh(self):
        if 'mesh' not in self._info:
            return

        mesher = Mesher()
        data = np.swapaxes(self._data, 0,2)
        mesher.mesh(data.flatten(), *data.shape)
        self._storage.add_file(
            filename=self._task.chunk_path + '.json',
            content=json.dumps(mesher.ids()))
        self._storage.flush('build/manifests/')

        for obj_id in tqdm(mesher.ids()):
            vbo = self.create_vbo(mesher, obj_id)
            self._storage.add_file(
                filename='{}:{}:{}'.format(obj_id, 0, self._task.chunk_path),
                content=vbo)
        self._storage.flush(self._info['mesh'])


    def create_vbo(self, mesher, obj_id):
        def update_points(points, resolution):
            # zlib meshing multiplies verticies by two to avoid working with floats like 1.5
            # but we need to recover the exact position for display
            points /= 2.0 

            points[0::3] = (points[0::3] + self._xmin) * resolution[0]   # x
            points[1::3] = (points[1::3] + self._ymin) * resolution[1]   # y
            points[2::3] = (points[2::3] + self._zmin) * resolution[2]   # z

            return points

        mesh = mesher.get_mesh(obj_id, simplification_factor=128, max_simplification_error=1000000)

        numpoints = len(mesh['points']) / 3
        numindicies = len(mesh['faces'])

        points = np.array(mesh['points'], dtype=np.float32)
        resolution = self._info['scales'][0]['resolution']
        scalepoints = update_points(points, resolution) 

        vertex_index_format = [
            np.array([ numpoints ], dtype=np.uint32),
            np.array(scalepoints, dtype=np.float32),
            np.array(mesh['faces'], dtype=np.uint32)
        ]

        return b''.join([ array.tobytes() for array in vertex_index_format ])

if __name__ == '__main__':
    tq = TaskQueue(PROJECT_NAME, QUEUE_NAME)
    while True:
      try:
        task = tq.lease()
        Runner(task)
        tq.delete(task)
      except TaskQueue.QueueEmpty:
        sleep(1)
        continue

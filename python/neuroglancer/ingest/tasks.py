from __future__ import print_function
import base64
from collections import defaultdict
import json
import itertools
import io
import os
import re
from tempfile import NamedTemporaryFile

import h5py
import blosc
import numpy as np
from backports import lzma
from tqdm import tqdm

from neuroglancer.ingest.storage import Storage, GoogleCloudStorageInterface, PROJECT_NAME, QUEUE_NAME
from neuroglancer.ingest.volumes.gcloudvolume import GCloudVolume
from neuroglancer import chunks, downsample
from neuroglancer.ingest.mesher import Mesher


class IngestTask(object):
    """Ingests and does downsampling.
       We want tasks execution to be independent of each other, so that no sincronization is
       required.
       The downsample scales should be such that the lowest resolution chunk should be able
       to be produce from the data available.
    """
    def __init__(self, chunk_path=None, chunk_encoding=None, layer_path=None, fromjson=None, _id=None):
        self.chunk_path = chunk_path
        self.chunk_encoding = chunk_encoding
        self.layer_path = layer_path
        self.tag = 'ingest'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'chunk_path': self.chunk_path,
            'chunk_encoding': self.chunk_encoding,
            'layer_path': self.layer_path
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.chunk_path = d['chunk_path']
        self.chunk_encoding = d['chunk_encoding']
        self.layer_path = d['layer_path']

    def __repr__(self):
        return "IngestTask(chunk_path='{}', chunk_encoding='{}', layer_path='{}'')".format(
            self.chunk_path, self.chunk_encoding, self.layer_path)

    def execute(self):
        self._storage = Storage(self.layer_path)
        self._parse_chunk_path()
        self._download_info()
        self._download_input_chunk()
        self._create_chunks()
        self._storage.wait_until_queue_empty()

    def _parse_chunk_path(self):
        match = re.match(r'^.*/(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_path)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
        self._filename = "{}-{}_{}-{}_{}-{}".format(
            self._xmin, self._xmax,
            self._ymin, self._ymax,
            self._zmin, self._zmax)

    def _download_info(self):
        self._info = json.loads(self._storage.get_file('info'))

    def _download_input_chunk(self):
        string_data = self._storage.get_file(os.path.join('build', self._filename))
        if self.chunk_encoding == 'npz':
          self._data = chunks.decode_npz(string_data)
        else:
          raise NotImplementedError(self.chunk_encoding)

    def _create_chunks(self):
        for scale in self._info["scales"]:
            for chunk_size in scale['chunk_sizes']:
                self._generate_chunks(scale, chunk_size)
                    

    def _generate_chunks(self, scale, chunk_size):
        highest_resolution = np.array(self._info['scales'][0]['resolution'])
        current_resolution = np.array(scale["resolution"])
        downsample_ratio = current_resolution / highest_resolution
        current_shape = self._data.shape[:-1] / downsample_ratio # we discard the channel component in data

        # This is required because last data chunk is allowed to not 
        # be a multiple of the chunk size.
        n_chunks = self._ceil(current_shape, chunk_size)
        for x,y,z in itertools.product(*list(map(xrange, n_chunks))):
            # numpy allows for index that are larger than the array size
            # because we are doing ceil in n_chunks, there will be cases where
            # chunk.shape is less than chunk_size. In that case the filename should 
            # base on chunk.shape.
            subvol = self._data[
                x * chunk_size[0] * downsample_ratio[0] : (x+1) * chunk_size[0] * downsample_ratio[0],
                y * chunk_size[1] * downsample_ratio[1] : (y+1) * chunk_size[1] * downsample_ratio[1],
                z * chunk_size[2] * downsample_ratio[2] : (z+1) * chunk_size[2] * downsample_ratio[2],
                :]
            chunk = downsample.downsample_with_striding(subvol, downsample_ratio)

            encoded = self._encode(chunk, scale["encoding"])
            filename = self._get_filename(x, y, z, chunk_size, downsample_ratio, scale)
            self._storage.put_file(filename, encoded)

    def _encode(self, chunk, encoding):
        if encoding == "jpeg":
            return chunks.encode_jpeg(chunk)
        elif encoding == "npz":
            return chunks.encode_npz(chunk)
        elif encoding == "raw":
            return chunks.encode_raw(chunk)
        else:
            raise NotImplementedError(encoding)

    def _ceil(self, arr1, arr2):
        return np.ceil(arr1.astype(np.float32) / arr2).astype(np.uint32)

    def _get_filename(self, x, y, z, chunk_size, downsample_ratio, scale):
        xmin = x * chunk_size[0] + self._xmin / downsample_ratio[0]
        xmax = min((x + 1) * chunk_size[0] + self._xmin / downsample_ratio[0], scale['size'][0] + scale['voxel_offset'][0])
        ymin = y * chunk_size[1] + self._ymin / downsample_ratio[1]
        ymax = min((y + 1) * chunk_size[1] + self._ymin / downsample_ratio[1], scale['size'][1] + scale['voxel_offset'][1])
        zmin = z * chunk_size[2] + self._zmin / downsample_ratio[2]
        zmax = min((z + 1) * chunk_size[2] + self._zmin / downsample_ratio[2], scale['size'][2] + scale['voxel_offset'][2])

        return '{}/{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(scale['key'],
          xmin, xmax, ymin, ymax, zmin, zmax) 

class DownsampleTask(object):
    def __init__(self, chunk_path=None, layer_path=None, fromjson=None, _id=None):
        self._id =  None
        self.chunk_path = chunk_path
        self.layer_path = layer_path
        self.tag = 'downsample'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'chunk_path': self.chunk_path,
            'layer_path': self.layer_path
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.chunk_path = d['chunk_path']
        self.layer_path = d['layer_path']

    def __repr__(self):
        return "DownsampleTask(chunk_path='{}', layer_path='{}')".format(
            self.chunk_path, self.layer_path)

    def execute(self):
        self._storage = Storage(self.layer_path)
        self._download_info()
        self._parse_chunk_path()
        self._compute_downsampling_ratio()
        self._download_input_chunk()
        self._upload_output_chunk()

    def _download_info(self):
        self._info = json.loads(self._storage.get_file('info'))

    def _parse_chunk_path(self):
        match = re.match(r'.*/([^//]+)/(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_path)
        self._key = match.groups()[0]
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups()[1:])

    def _compute_downsampling_ratio(self):
        self._current_index = self._find_scale_idx()
        current_resolution = self._info['scales'][self._current_index]['resolution']
        higher_resolution = self._info['scales'][self._current_index-1]['resolution']
        self._downsample_ratio = [ c/h for c,h in zip(current_resolution, higher_resolution)] + [1]

    def _find_scale_idx(self):
        for scale_idx, scale in enumerate(self._info['scales']):
            if scale['key'] == self._key:
                assert scale_idx > 0
                return scale_idx

    def _download_input_chunk(self):
        #TODO make this work with storage
        volume = GCloudVolume(self._storage._path.dataset_name,
                             self._storage._path.layer_name,
                             mip=self._current_index-1,
                             cache_files=False)
        chunk = volume[
            self._xmin * self._downsample_ratio[0]:self._xmax * self._downsample_ratio[0],
            self._ymin * self._downsample_ratio[1]:self._ymax * self._downsample_ratio[1],
            self._zmin * self._downsample_ratio[2]:self._zmax * self._downsample_ratio[2]]
        self._downsample_chunk(chunk)

    def _downsample_chunk(self, chunk):
        if self._info['type'] == 'image':
            self._data = downsample.downsample_with_averaging(chunk, self._downsample_ratio)
        elif self._info['type'] == 'segmentation':
            self._data = downsample.downsample_segmentation(chunk, self._downsample_ratio)
        else:
            raise NotImplementedError(self._info['type'])

    def _upload_output_chunk(self): 
        self._storage.put_file(
            file_path=self._get_filename(),
            content=self._encode(self._data, self._info['scales'][self._current_index]["encoding"])
            )

    def _encode(self, chunk, encoding):
        if encoding == "jpeg":
            return chunks.encode_jpeg(chunk)
        elif encoding == "npz":
            return chunks.encode_npz(chunk)
        elif encoding == "raw":
            return chunks.encode_raw(chunk)
        else:
            raise NotImplementedError(encoding)

    def _get_filename(self):
        return '{}/{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(self._key,
          self._xmin, self._xmax, self._ymin, self._ymax, self._zmin, self._zmax) 


class MeshTask(object):

    def __init__(self, chunk_key=None, chunk_position=None, layer_path=None, 
                 lod=0, simplification=5, segments=[], fromjson=None, _id=None):
        self._id =  None
        self.chunk_key = chunk_key
        self.chunk_position = chunk_position
        self.layer_path = layer_path
        self.lod = lod
        self.simplification = simplification
        self.segments = segments
        self.tag = 'mesh'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'chunk_key': self.chunk_key,
            'chunk_position': self.chunk_position,
            'layer_path': self.layer_path,
            'lod': self.lod,
            'simplification': self.simplification,
            'segments': self.segments
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.chunk_key = d['chunk_key']
        self.chunk_position = d['chunk_position']
        self.layer_path = d['layer_path']
        self.lod = d['lod']
        self.simplification = d['simplification']
        self.segments = d['segments'] 

    def __repr__(self):
        return "MeshTask(chunk_key='{}', chunk_position='{}', layer_path='{}', lod={}, simplification={}, segments={})".format(
            self.chunk_key, self.chunk_position, self.layer_path, self.lod, self.simplification, self.segments)

    def execute(self):
        self._storage = Storage(self.layer_path)
        self._mesher = Mesher()
        self._parse_chunk_key()
        self._parse_chunk_position()
        self._download_info()
        self._download_input_chunk()
        self._compute_meshes()

    def _parse_chunk_key(self):
        self._key = self.chunk_key.split('/')[-1]

    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())
    
    def _download_info(self):
        self._info = json.loads(self._storage.get_file('info'))

        if 'mesh' not in self._info:
            raise ValueError("Path on where to store the meshes is not present")

    def _download_input_chunk(self):
        """
        It assumes that the chunk_position includes a 1 pixel overlap
        FIXME choose the mip level based on the chunk key
        """
        volume = GCloudVolume(self._storage._path.dataset_name,
                             self._storage._path.layer_name,
                             mip=0,
                             cache_files=False)        

        self._data = volume[self._xmin:self._xmax,
                            self._ymin:self._ymax,
                            self._zmin:self._zmax]

    def _compute_meshes(self):
        data = np.swapaxes(self._data[:,:,:,0], 0,2)
        self._mesher.mesh(data.flatten(), *data.shape)
        for obj_id in tqdm(self._mesher.ids()):
            self._storage.put_file(
                file_path='{}/{}:{}:{}'.format(self._info['mesh'], obj_id, self.lod, self.chunk_position),
                content=self._create_mesh(obj_id))

    def _create_mesh(self, obj_id):
        mesh = self._mesher.get_mesh(obj_id, simplification_factor=128, max_simplification_error=1000000)
        vertices = self._update_vertices(np.array(mesh['points'], dtype=np.float32)) 
        vertex_index_format = [
            np.uint32(len(vertices) / 3), #Number of vertices (each vertex it's composed of three numbers(x,y,z))
            vertices,
            np.array(mesh['faces'], dtype=np.uint32)
        ]
        return b''.join([ array.tobytes() for array in vertex_index_format ])

    def _update_vertices(self, points):
        # zlib meshing multiplies verticies by two to avoid working with floats like 1.5
        # but we need to recover the exact position for display
        points /= 2.0
        resolution = self._info['scales'][0]['resolution']
        points[0::3] = (points[0::3] + self._xmin) * resolution[0]   # x
        points[1::3] = (points[1::3] + self._ymin) * resolution[1]   # y
        points[2::3] = (points[2::3] + self._zmin) * resolution[2]   # z
        return points


class MeshManifestTask(object):
    """
    Finalize mesh generation by post-processing chunk fragment
    lists into mesh fragment manifests.
    These are necessary for neuroglancer to know which mesh
    fragments to download for a given segid.
    """
    def __init__(self, layer_path=None, lod=None, fromjson=None, _id=None):
        self._id =  None
        self.layer_path = layer_path
        self.lod = lod
        self.tag = 'mesh_manifest'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'layer_path': self.layer_path,
            'lod': self.lod
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.layer_path = d['layer_path']
        self.lod = d['lod']

    def __repr__(self):
        return "MeshManifestTask(layer_path='{}', lod={})".format(
            self.layer_path, self.lod)

    def execute(self):
        self._storage = Storage(self.layer_path)
        self._download_info()
        self._download_input_chunk()

    def _download_info(self):
        self._info = json.loads(self._storage.get_file('info'))
        
    def _download_input_chunk(self):
        """
        Assumes that list blob is lexicographically ordered
        """
        last_id = 0
        last_fragments = []
        for filename in self._storage.list_files(prefix='mesh/'):
            match = re.match(r'(\d+):(\d+):(.*)$',filename)
            if not match: # a manifest file will not match
                continue
            _id, lod, chunk_position = match.groups()
            _id = int(_id); lod = int(lod)
            if lod != self.lod:
                continue

            if last_id != _id:
                self._storage.put_file(
                    file_path='{}/{}:{}'.format(self._info['mesh'],last_id, self.lod),
                    content=json.dumps({"fragments": last_fragments}))
                last_id = _id
                last_fragments = []

            last_fragments.append('{}:{}:{}'.format(_id, lod, chunk_position))

class BigArrayTask(object):
    def __init__(self, layer_path, chunk_path=None, chunk_encoding=None, version=None, fromjson=None, _id=None):
        self._id =  None
        self.layer_path = layer_path
        self.chunk_path = chunk_path
        self.chunk_encoding = chunk_encoding
        self.version = version
        self.tag = 'bigarray'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'chunk_path': self.chunk_path,
            'chunk_encoding': self.chunk_encoding,
            'version': self.version,
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.chunk_path = d['chunk_path']
        self.chunk_encoding = d['chunk_encoding']
        self.version = d['version']

    def __repr__(self):
        return "BigArrayTask(chunk_path='{}, chunk_encoding='{}', version='{}')".format(
            self.chunk_path, self.chunk_encoding, self.version)

    def execute(self):
        self._parse_chunk_path()
        self._storage = Storage(self.layer_path)
        self._download_input_chunk()
        self._upload_chunk()

    def _parse_chunk_path(self):
        if self.version == 'zfish_v0/affinities':
            match = re.match(r'^.*/bigarray/block_(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)_1-3.h5$',
                self.chunk_path)
        elif self.version == 'zfish_v0/image' or self.version == 'pinky_v0/image':
            match = re.match(r'^.*/bigarray/(\d+):(\d+)_(\d+):(\d+)_(\d+):(\d+)$',
                self.chunk_path)
        else:
            raise NotImplementedError(self.version)

        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = match.groups()
         
        self._xmin = int(self._xmin)
        self._xmax = int(self._xmax)
        self._ymin = int(self._ymin)
        self._ymax = int(self._ymax)
        self._zmin = int(self._zmin)
        self._zmax = int(self._zmax)
        self._filename = self.chunk_path.split('/')[-1]

    def _download_input_chunk(self):
        string_data = self._storage.get_file(os.path.join('bigarray',self._filename))
        if self.version == 'zfish_v0/affinities':
            self._data = self._decode_hdf5(string_data)
        elif self.version == 'zfish_v0/image':
            self._data = self._decode_blosc(string_data, shape=[2048, 2048, 128])
        elif self.version == 'pinky_v0/image':
            self._data = self._decode_blosc(string_data, shape=[2048, 2048, 64])
        else:
          raise NotImplementedError(self.version)

    def _decode_blosc(self, string, shape):
        seeked = blosc.decompress(string[10:])
        arr =  np.fromstring(seeked, dtype=np.uint8).reshape(
            shape[::-1]).transpose((2,1,0))
        return np.expand_dims(arr,3)


    def _decode_hdf5(self, string):
        with NamedTemporaryFile(delete=False) as tmp:
            tmp.write(string)
            tmp.close()
            with h5py.File(tmp.name,'r') as h5:
                return np.transpose(h5['img'][:], axes=(3,2,1,0))

    def _upload_chunk(self):
        if self.version == 'zfish_v0/affinities':
            shape = [313472, 193664, 1280]
            offset = [14336, 11264, 16384]
        elif self.version == 'zfish_v0/image':
            shape = [69632, 34816, 1280]
            offset = [14336, 12288, 16384]
        elif self.version == 'pinky_v0/image':
            shape = [100352, 55296, 1024]
            offset = [2048, 14336, 16384]
        else:
            raise NotImplementedError(self.version)

        xmin = self._xmin - offset[0] - 1
        xmax = min(self._xmax - offset[0], shape[0])
        ymin = self._ymin - offset[1] - 1
        ymax = min(self._ymax - offset[1], shape[1])
        zmin = self._zmin - offset[2] - 1
        zmax = min(self._zmax - offset[2], shape[2])

        #bigarray chunk has padding to fill the volume
        chunk = self._data[:xmax-xmin, :ymax-ymin, :zmax-zmin, :]
        filename = 'build/{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(
          xmin, xmax, ymin, ymax, zmin, zmax)
        encoded = self._encode(chunk, self.chunk_encoding)
        self._storage.put_file(filename, encoded)

    def _encode(self, chunk, encoding):
        if encoding == "jpeg":
            return chunks.encode_jpeg(chunk)
        elif encoding == "npz":
            return chunks.encode_npz(chunk)
        elif encoding == "npz_uint8":
            chunk = chunk * 255
            chunk = chunk.astype(np.uint8)
            return chunks.encode_npz(chunk)
        elif encoding == "raw":
            return chunks.encode_raw(chunk)
        else:
            raise NotImplementedError(encoding)

class HyperSquareTask(object):
    def __init__(self, chunk_path=None, chunk_encoding=None, version=None, layer_path=None, fromjson=None, _id=None):
        self._id =  None
        self.chunk_path = chunk_path
        self.chunk_encoding = chunk_encoding
        self.version = version
        self.layer_path = layer_path
        self.tag = 'hypersquare'
        if fromjson:
            self.payloadBase64 = fromjson
            self._id = _id

    @property
    def payloadBase64(self):
        payload = json.dumps({
            'chunk_path': self.chunk_path,
            'chunk_encoding': self.chunk_encoding,
            'version': self.version,
            'layer_path': self.layer_path
        })
        return base64.b64encode(payload)
    
    @payloadBase64.setter
    def payloadBase64(self, payload):
        decoded_string =  base64.b64decode(payload).encode('ascii')
        d = json.loads(decoded_string)
        self.chunk_path = d['chunk_path']
        self.chunk_encoding = d['chunk_encoding']
        self.version = d['version']
        self.layer_path = d['layer_path']

    def __repr__(self):
        return "HyperSquareTask(chunk_path='{}, chunk_encoding='{}', version='{}', layer_path='{}')".format(
            self.chunk_path, self.chunk_encoding, self.version, self.layer_path)

    def execute(self):
        self._parse_chunk_path()
        self._storage = Storage(self.layer_path)
        self._download_metadata()
        self._download_input_chunk()
        self._upload_chunk()

    def _parse_chunk_path(self):
        if 'segmentation' in self._storage._path.layer_name: 
            match = re.match(r'^gs://(.*)/(.*)/segmentation.lzma', self.chunk_path)
            self._bucket_name, self._chunk_folder = match.groups()
        elif 'image' in self._storage._path.layer_name:
            match = re.match(r'^gs://(.*)/(.*)/jpg/0\.jpg', self.chunk_path)
            self._bucket_name, self._chunk_folder = match.groups()
        else:
            return NotImplementedError("Don't know how process this layer")

    def _download_metadata(self):
        #FIXME self._storage._client doesn't exist anymore
        self._bucket = self._storage._client.get_bucket(self._bucket_name)
        metadata = self._bucket.get_blob(
            '{}/metadata-fixed.json'.format(self._chunk_folder)) \
        .download_as_string()
        self._metadata = json.loads(metadata)
        
    def _download_input_chunk(self):
        if 'segmentation' in self._storage._path.layer_name: 
            self._datablob = self._bukcet.get_blob(
                '{}/segmentation.lzma'.format(self._chunk_folder))
            string_data = self._datablob.download_as_string()
            self._data = self._decode_lzma(string_data)
        elif 'image' in self._storage._path.layer_name:
            self._data = np.zeros(shape=(256,256,256), dtype=np.uint8) #x,y,z,channels
            for blob in self._bucket.list_blobs(prefix='{}/jpg'.format(self._chunk_folder)):
                z = int(re.findall(r'(\d+)\.jpg', blob.name)[0])
                img = blob.download_as_string()
                self._data[:,:,z] = chunks.decode_jpeg(img, shape=(256,256,1)).transpose()
            self._data.transpose((2,1,0))
        else:
            return NotImplementedError("Don't know how to get the images for this layer")

    def _decode_lzma(self, string_data):
        arr = lzma.decompress(string_data)
        if self._metadata['segment_id_type'] == 'UInt8':
            arr = np.fromstring(arr, dtype=np.uint8)
        elif self._metadata['segment_id_type'] == 'UInt16':
            arr = np.fromstring(arr, dtype=np.uint16)
        elif self._metadata['segment_id_type'] == 'UInt32':
            arr = np.fromstring(arr, dtype=np.uint32)
        elif self._metadata['segment_id_type'] == 'UInt64':
            arr = np.fromstring(arr, dtype=np.uint64)
        arr = arr.reshape(self._metadata['chunk_voxel_dimensions'][::-1])
        return arr.transpose((2,1,0))

    def _upload_chunk(self):
        if self._dataset_name == 'zfish_v0':
            overlap = [64, 64, 8]
        elif self._dataset_name == 'e2198_v0':
            overlap = [16, 16, 16]
        else:
            raise NotImplementedError(self.version)
 
        chunk = np.expand_dims(self._data[overlap[0]:-overlap[0],
                                          overlap[1]:-overlap[1],
                                          overlap[2]:-overlap[2]],3)
        voxel_resolution = np.array(self._metadata['voxel_resolution'])

        xmin, ymin, zmin = (self._metadata['physical_offset_min'] / voxel_resolution) + overlap
        xmax, ymax, zmax = (self._metadata['physical_offset_max'] / voxel_resolution) - overlap
        filename = 'build/{:d}-{:d}_{:d}-{:d}_{:d}-{:d}'.format(
          xmin, xmax, ymin, ymax, zmin, zmax)
        encoded = self._encode(chunk, self.chunk_encoding)
        self._storage.put_file(filename, encoded)

    def _encode(self, chunk, encoding):
        if encoding == "jpeg":
            return chunks.encode_jpeg(chunk)
        elif encoding == "npz":
            return chunks.encode_npz(chunk)
        elif encoding == "raw":
            return chunks.encode_raw(chunk)
        else:
            raise NotImplementedError(encoding)


class TaskQueue(object):
    """
    The standard usage is that a client calls lease to get the next available task,
    performs that task, and then calls task.delete on that task before the lease expires.
    If the client cannot finish the task before the lease expires,
    and has a reasonable chance of completing the task,
    it should call task.update before the lease expires.

    If the client completes the task after the lease has expired,
    it still needs to delete the task. 

    Tasks should be designed to be idempotent to avoid errors 
    if multiple clients complete the same task.
    """
    class QueueEmpty(LookupError):
        def __init__(self):
            super(LookupError, self).__init__('Queue Empty')

    def __init__(self, project=PROJECT_NAME, queue_name=QUEUE_NAME, local=True):
        self._project = 's~' + project # unsure why this is necessary
        self._queue_name = queue_name

        if local:
            from oauth2client import service_account
            credentials_path = GoogleCloudStorageInterface.credentials_path()
            self._credentials = service_account.ServiceAccountCredentials \
            .from_json_keyfile_name(credentials_path)
        else:
            from oauth2client.client import GoogleCredentials
            self._credentials = GoogleCredentials.get_application_default()

        from googleapiclient.discovery import build
        self.api =  build('taskqueue', 'v1beta2', credentials=self._credentials).tasks()


    def insert(self, task):
        """
        Insert a task into an existing queue.
        """
        body = {
            "payloadBase64": task.payloadBase64,
            "queueName": self._queue_name,
            "groupByTag": True,
            "tag": task.tag
        }

        self.api.insert(project=self._project,
                        taskqueue=self._queue_name,
                        body=body).execute(num_retries=6)


    def get(self):
        """
        Gets the named task in a TaskQueue.
        """
        raise NotImplemented

    def list(self):
        """
        Lists all non-deleted Tasks in a TaskQueue, 
        whether or not they are currently leased, up to a maximum of 100.
        """
        print (self.api.list(project=self._project, taskqueue=self._queue_name).execute(num_retries=6))


    def update(self, task):
        """
        Update the duration of a task lease.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def lease(self, tag=''):
        """
        Acquires a lease on the topmost N unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks
        """
        if not tag:
            tasks = self.api.lease(
                project=self._project,
                taskqueue=self._queue_name, 
                numTasks=1, 
                leaseSecs=600,
                ).execute(num_retries=6)
        else:
            tasks = self.api.lease(
                project=self._project,
                taskqueue=self._queue_name, 
                numTasks=1, 
                leaseSecs=600,
                groupByTag=True,
                tag=tag).execute(num_retries=6)


        if not 'items' in tasks:
            raise TaskQueue.QueueEmpty
        
          
        task_json = tasks['items'][0]
        
        if task_json['tag'] == 'ingest':
            return IngestTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])
        elif task_json['tag'] == 'downsample':
            return DownsampleTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])
        elif task_json['tag'] == 'mesh':
            return MeshTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])
        elif task_json['tag'] == 'mesh_manifest':
            return MeshManifestTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])
        elif task_json['tag'] == 'bigarray':
            return BigArrayTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])    
        elif task_json['tag'] == 'hypersquare':
            return HyperSquareTask(fromjson=task_json['payloadBase64'], _id=task_json['id'])  
        else:
            raise NotImplementedError

    def patch(self):
        """
        Update tasks that are leased out of a TaskQueue.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def delete(self, task):
        """Deletes a task from a TaskQueue."""
        self.api.delete(
            project=self._project,
            taskqueue=self._queue_name,
            task=task._id).execute(num_retries=6)


if __name__ == '__main__':
    tq = TaskQueue()
    t = BigArrayTask(
        chunk_path='gs://neuroglancer/zfish_v0/affinities/bigarray/block_14337-15360_18433-19456_16385-16512_1-3.h5',
        chunk_encoding='npz_uint8',
        version='zfish_affinities')
    t.execute()
    # tq.delete(t)
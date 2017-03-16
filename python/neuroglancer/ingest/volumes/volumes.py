import os
import re

import h5py
import requests
import numpy as np
from tqdm import tqdm
from PIL import Image

from neuroglancer.ingest.lib import mkdir, COMMON_STAGING_DIR

class Volume(object):

    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        raise NotImplemented

    @property
    def shape(self):
        """
        Asumes x,y,z coordinates
        """
        if len(self._shape) == 3:
            return self._shape
        elif len(self._shape) == 4:
            return self._shape[:-1]
        else:
            raise Exception('Wrong shape')  

    @property
    def data_type(self):
        """
        Data type of the voxels in this volume
        """

        return self._data_type

    @property
    def layer_type(self):
        """
        Either segmentation or image
        """
        if self._layer_type == 'affinities':
            return 'image'

        return self._layer_type

    @property
    def mesh(self):
        """
        Return True if mesh is desired
        """
        return self._mesh

    @property
    def resolution(self):
        """
        Size of voxels in nanometers
        """
        return self._resolution

    @property
    def offset(self):
        """
        distantance to the pixel closes to the origin
        """
        return self._offset

    @property
    def underlying(self):
        """
        Size of the underlying chunks in pixels
        """
        return self._underlying

    @property
    def num_channels(self):
        if len(self._shape) == 3:
            return 1
        elif len(self._shape) == 4:
            return self._shape[-1]
        else:
            raise Exception('Wrong shape')

    @property
    def encoding(self):
        if self._layer_type == 'affinities':
            return 'raw'
        elif self._layer_type == 'image':
            return 'jpeg'
        elif self._layer_type == 'segmentation':
            return 'raw'
        else:
            raise NotImplementedError(self._layer_type)
      
    
class HDF5Volume(Volume):

    def __init__(self, path, layer_type, resolution=[1,1,1], offset=[0,0,0]):
        self._layer_type = layer_type
        self._f = h5py.File(path, 'r')
        self._data = self._f['main']      
        self._mesh = (self._layer_type == 'segmentation')
        self._resolution = resolution
        self._offset = offset
        self._shape = self._data.shape[::-1]
        self._underlying = self.shape
        
        if self._layer_type == "affinities":
            self._data_type = "uint8"
        else:
            self._data_type = self._f['main'].dtype

    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        data = self._data.__getitem__(slices[::-1])
        if self._layer_type == "affinities":
            data = data.transpose((3,2,1,0)) * 255.0
            return data.astype(np.uint8) 
        else:
            return np.expand_dims(np.swapaxes(data,0,2),3)

    def __del__(self):
        self._f.close()


class NumpyVolume(Volume):

    def __init__(self, resolution=[1,1,1], offset=[0,0,0]):
        arr = np.ones(shape=(127,127,127),dtype=np.uint32)
        self._data = np.pad(arr, 1, 'constant')
        self._layer_type = 'segmentation'
        self._mesh = True
        self._resolution = resolution
        self._offset = offset
        self._underlying = self.shape
        self._data_type = self._data.dtype
        self._shape = self._data.shape

    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        return self._data.__getitem__(slices)

class EmptyVolume(Volume):
    def __init__(self, shape, offset):
        self._layer_type = 'segmentation'
        self._mesh = True
        self._resolution = [5, 5, 45] 
        self._offset = offset
        self._underlying = [896,896,112]
        self._data_type = "uint16"
        self._shape = shape


class VolumeCutout(np.ndarray):

  def __new__(cls, buf, dataset_name, layer, mip, layer_type, bounds, *args, **kwargs):
    return super(VolumeCutout, cls).__new__(cls, shape=buf.shape, buffer=buf, dtype=buf.dtype)

  def __init__(self, buf, dataset_name, layer, mip, layer_type, bounds, *args, **kwargs):
    super(VolumeCutout, self).__init__(self, shape=buf.shape, buffer=buf, dtype=buf.dtype)
    
    self.dataset_name = dataset_name
    self.layer = layer
    self.mip = mip
    self.layer_type = layer_type
    self.bounds = bounds

  def save_images(self, axis='z', directory=None, image_format="PNG"):

    if directory is None:
      directory = os.path.join(COMMON_STAGING_DIR, 'save_images', self.dataset_name, self.layer, str(self.mip), self.bounds.to_filename())
    
    mkdir(directory)

    print "Saving to {}".format(directory)

    indexmap = {
        'x': 0,
        'y': 1,
        'z': 2,
    }

    index = indexmap[axis]

    for level in tqdm(xrange(self.shape[index]), desc="Saving Images"):
      if index == 0:
        img = self[level, :, :]
      elif index == 1:
        img = self[:, level, :]
      elif index == 2:
        img = self[:, :, level]
      else:
        raise NotImplemented

      # discovered that downloaded cube is in a weird rotated state.
      # it requires a 90deg counterclockwise rotation on xy plane (leaving z alone)
      # followed by a flip on Y
      if axis == 'z':
        img = np.flipud(np.rot90(img, 1)) 

      img = Image.fromarray(img)

      path = os.path.join(directory,'{}.{}'.format(level, image_format.lower()))

      img.save(path, image_format)




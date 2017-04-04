import os
import re

import h5py
import requests
import numpy as np
from tqdm import tqdm
from PIL import Image

from neuroglancer.ingest.lib import Vec, clamp, mkdir, COMMON_STAGING_DIR, xyzrange

def generate_slices(slices, maxsize):
  """Assisting function for __getitem__. e.g. vol[:,:,:,:]"""
  if isinstance(slices, int) or isinstance(slices, float) or isinstance(slices, long):
    slices = [ slice(int(slices), int(slices)+1, 1) ]
  if type(slices) == slice:
    slices = [ slices ]

  slices = list(slices)

  while len(slices) < len(maxsize):
    slices.append( slice(None, None, None) )

  # First three slices are x,y,z, last is channel. 
  # Handle only x,y,z here, channel seperately
  for index, slc in enumerate(slices):
    if isinstance(slc, int) or isinstance(slc, float) or isinstance(slc, long):
      slices[index] = slice(int(slc), int(slc)+1, 1)
    else:
      start = 0 if slc.start is None else clamp(slc.start, 0, maxsize[index])
      end = maxsize[index] if slc.stop is None else clamp(slc.stop, 0, maxsize[index])
      step = 1 if slc.step is None else slc.step

      slices[index] = slice(start, end, step)

  return slices

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

  def __init__(self, path, layer_type):
    self._layer_type = layer_type
    self._f = h5py.File(path, 'r')
    self._data = self._f['main']      
    self._shape = self._data.shape[::-1]               
    if self._layer_type == "affinities":
        self._data_type = "uint8"
    else:
        self._data_type = self._f['main'].dtype

  def __getitem__(self, slices):
    """
    Asumes x,y,z,channels coordinates fortran order
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

  def __init__(self):
    arr = np.ones(shape=(127,127,127),dtype=np.uint32)
    self._data = np.pad(arr, 1, 'constant')
    self._layer_type = 'segmentation'
    self._mesh = True
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
    return super(VolumeCutout, cls).__new__(cls, shape=buf.shape, buffer=np.ascontiguousarray(buf), dtype=buf.dtype)

  def __init__(self, buf, dataset_name, layer, mip, layer_type, bounds, *args, **kwargs):
    super(VolumeCutout, self).__init__(self, shape=buf.shape, buffer=buf, dtype=buf.dtype)
    
    self.dataset_name = dataset_name
    self.layer = layer
    self.mip = mip
    self.layer_type = layer_type
    self.bounds = bounds

  @classmethod
  def from_volume(cls, volume, buf, bounds):
    return VolumeCutout(
      buf=buf,
      dataset_name=volume.dataset_name,
      layer=volume.layer,
      mip=volume.mip,
      layer_type=volume.layer_type,
      bounds=bounds,
    )

  @property
  def num_channels(self):
    return self.shape[3]

  def upload(self, info):
    bounds = self.bounds.shrunk_to_chunk_size( (64,64,64) )

  def save_images(self, axis='z', channel=None, directory=None, image_format='PNG'):

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

    channel = slice(None) if channel is None else channel

    for level in tqdm(xrange(self.shape[index]), desc="Saving Images"):
      if index == 0:
        img = self[level, :, :, channel ]
      elif index == 1:
        img = self[:, level, :, channel ]
      elif index == 2:
        img = self[:, :, level, channel ]
      else:
        raise NotImplemented

      num_channels = img.shape[2]

      for channel_index in xrange(num_channels):
        img2d = img[:, :, channel_index]

        # discovered that downloaded cube is in a weird rotated state.
        # it requires a 90deg counterclockwise rotation on xy plane (leaving z alone)
        # followed by a flip on Y
        if axis == 'z':
          img2d = np.flipud(np.rot90(img2d, 1)) 

        if img2d.dtype == 'uint8':
          img2d = Image.fromarray(img2d, 'L')
        else:
          img2d = img2d.astype('uint32')
          img2d *= 32
          img2d[:,:] |= 0xff000000 # for little endian abgr
          img2d = Image.fromarray(img2d, 'RGBA')

        filename = '{}.{}'.format(level, image_format.lower())
        if num_channels > 1:
          filename = '{}-{}'.format(channel_index, filename)

        path = os.path.join(directory, filename)
        img2d.save(path, image_format)




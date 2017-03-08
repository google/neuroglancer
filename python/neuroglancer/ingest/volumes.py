import numpy as np
import requests
import re
import h5py

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
    def underlying(self):
        """
        Size of the underlying chunks
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
        self._mesh = (self._layer_type == 'segmentation')
        self._resolution = [6,6,30]
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

    def __init__(self):
        arr = np.ones(shape=(127,127,127),dtype=np.uint32)
        self._data = np.pad(arr, 1, 'constant')
        self._layer_type = 'segmentation'
        self._mesh = True
        self._resolution = [6,6,30]
        self._underlying = self.shape
        self._data_type = self._data.dtype
        self._shape = self._data.shape

    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        return self._data.__getitem__(slices)

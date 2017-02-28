import numpy as np
import requests

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
        return self._shape

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
        if len(self.shape) == 3:
            return 1
        elif len(self.shape) == 4:
            return self.shape[0]
        else:
            raise Exception('Wrong shape')  
    
class HDF5Volume(Volume):

    def __init__(self, path):
        import h5py
        self._f = h5py.File(path, 'r')
        self._data = self._f['main']
        self._layer_type = 'image'
        self._mesh = False
        self._resolution = [4,4,40]
        self._underlying = self.shape
        self._data_type = self._f['main'].dtype

    @property
    def shape(self):
        return self._data.shape[::-1]


    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        return np.swapaxes(self._data.__getitem__(slices[::-1]),0,2)

    def __del__(self):
        self._f.close()

class FakeVolume(Volume):

    def __init__(self):
        arr = np.ones(shape=(127,127,127),dtype=np.uint32)
        self._data = np.pad(arr, 1, 'constant')
        self._layer_type = 'image'
        self._mesh = False
        self._resolution = [6,6,30]
        self._underlying = self.shape
        self._data_type = self._data.dtype

    @property
    def shape(self):
        return self._data.shape


    def __getitem__(self, slices):
        """
        Asumes x,y,z coordinates
        """
        return self._data.__getitem__(slices)

class DVIDVolume(Volume):

    def __init__(self):
        self._info = requests.get('http://seung-titan01.pni.princeton.edu:8000/api/node/5d7b0fea4b674a1ea48020f1abaaf009/tiles4/info').json()
        self._resolution = self._info['Extended']['Levels']['0']['Resolution']
        self._shape = self._info['Extended']['MaxTileCoord']
        self._underlying = self._info['Extended']['Levels']['0']['TileSize']
        self._layer_type = 'image'
        self._mesh = False
        self._data_type = 'uint8'

    def __getitem__(self, slices):
        x, y, z = slices
        x_size = x.stop - x.start; x_min = x.start
        y_size = y.stop - y.start; y_min = y.start
        z_size = z.stop - z.start; z_min = z.start

        url = "{api}/node/{UUID}/{dataname}/raw/{dims}/{size}/{offset}/nd".format(
            api="http://seung-titan01.pni.princeton.edu:8000/api",
            UUID="5d7b0fea4b674a1ea48020f1abaaf009",
            dataname="grayscale",
            dims="0_1_2",
            size="_".join(map(str,[x_size,y_size,z_size])),
            offset="_".join(map(str,[x_min, y_min, z_min])),
            )

        return np.swapaxes(np.fromstring(requests.get(url).content , np.uint8).reshape(z_size,y_size,x_size),0,2)

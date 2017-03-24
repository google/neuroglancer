import os
import json
import re

import numpy as np
from tqdm import tqdm

import lib
from lib import clamp, xyzrange, Vec3, Bbox, min2, mkdir, COMMON_STAGING_DIR
import neuroglancer
from volumes import Volume, VolumeCutout
from google.cloud import storage as gstorage

class GCloudVolume(Volume):
  def __init__(self, dataset_name, layer, mip, cache_files=True, use_ls=True):
    super(self.__class__, self).__init__()

    # You can access these two with properties
    self._dataset_name = dataset_name
    self._layer = layer

    self.mip = mip
    
    self.cache_files = cache_files
    self.use_ls = use_ls

    self.refreshInfo()

    try:
      self.mip = self.available_mips[self.mip]
    except:
      raise Exception("MIP {} has not been generated.".format(self.mip))

  def refreshInfo(self):
    blob = self.__getInfoBlob()
    self.info = json.loads(blob.download_as_string())
    return self

  def commit(self):
    blob = self.__getInfoBlob()
    blob.upload_from_string(json.dumps(self.info), 'application/json')
    return self

  def __getInfoBlob(self):
    client = gstorage.Client(project=lib.GCLOUD_PROJECT_NAME)
    bucket = client.get_bucket(lib.GCLOUD_BUCKET_NAME)

    info_path = os.path.join(self.dataset_name, self.layer, 'info')
    return gstorage.blob.Blob(info_path, bucket)

  @property
  def dataset_name(self):
    return self._dataset_name

  @dataset_name.setter
  def dataset_name(self, name):
    if name != self._dataset_name:
      self._dataset_name = name
      self.refreshInfo()
  @property

  def layer(self):
    return self._layer

  @layer.setter
  def layer(self, name):
    if name != self._layer:
      self._layer = name
      self.refreshInfo()

  @property
  def scale(self):
    return self.mip_scale(self.mip)

  def mip_scale(self, mip):
    return self.info['scales'][mip]

  @property
  def base_cloudpath(self):
    return "gs://{}/{}/".format(lib.GCLOUD_BUCKET_NAME, self.dataset_name)

  @property
  def shape(self):
    return self.mip_shape(self.mip)

  def mip_shape(self, mip):
    return Vec3(*self.info['scales'][mip]['size'])

  @property
  def available_mips(self):
    return range(len(self.info['scales']))

  @property
  def layer_type(self):
    return self.info['type']

  @property
  def data_type(self):
    return self.info['data_type']

  @property
  def encoding(self):
    return self.mip_encoding(self.mip)

  def mip_encoding(self, mip):
    return self.info['scales'][mip]['encoding']

  @property
  def num_channels(self):
    return self.info['num_channels']

  @property
  def voxel_offset(self):
    return self.mip_voxel_offset(self.mip)

  def mip_voxel_offset(self, mip):
    return Vec3(*self.info['scales'][mip]['voxel_offset'])

  @property 
  def resolution(self):
    return self.mip_resolution(self.mip)

  def mip_resolution(self, mip):
    return Vec3(*self.info['scales'][mip]['resolution'])

  @property
  def downsample_ratio(self):
    return self.resolution / self.mip_resolution(0)

  @property
  def underlying(self):
    return self.mip_underlying(self.mip)

  def mip_underlying(self, mip):
    return Vec3(*self.info['scales'][mip]['chunk_sizes'][0])

  @property
  def key(self):
    return self.mip_key(self.mip)

  def mip_key(self, mip):
    return self.info['scales'][mip]['key']

  @property
  def bounds(self):
    return self.mip_bounds(self.mip)

  def mip_bounds(self, mip):
    offset = self.mip_voxel_offset(mip)
    shape = self.mip_shape(mip)
    return Bbox( offset, offset + shape )

  def addScale(self, factor):
    # e.g. {"encoding": "raw", "chunk_sizes": [[64, 64, 64]], "key": "4_4_40", 
    # "resolution": [4, 4, 40], "voxel_offset": [0, 0, 0], 
    # "size": [2048, 2048, 256]}
    fullres = self.info['scales'][0]

    newscale = {
      u"encoding": fullres['encoding'],
      u"chunk_sizes": fullres['chunk_sizes'],
      u"resolution": list( Vec3(*fullres['resolution']) * factor ),
      u"voxel_offset": list(np.ceil(Vec3(*fullres['voxel_offset']) / Vec3(*factor)).astype(int) ),
      u"size": list(np.ceil(Vec3(*fullres['size']) / Vec3(*factor)).astype(int)),
    }

    newscale[u'key'] = unicode("_".join([ str(res) for res in newscale['resolution']]))

    new_res = np.array(newscale['resolution'], dtype=int)

    preexisting = False
    for index, scale in enumerate(self.info['scales']):
      res = np.array(scale['resolution'], dtype=int)
      if np.array_equal(new_res, res):
        preexisting = True
        self.info['scales'][index] = newscale
        break

    if not preexisting:    
      self.info['scales'].append(newscale)

    return newscale

  def __getitem__(self, slices):
    slices = list(slices)

    while len(slices) < 3:
      slices.append( slice() )

    maxsize = Vec3(*self.info['scales'][self.mip]['size'])
    
    for index, slc in enumerate(slices):
      if isinstance(slc, int) or isinstance(slc, float) or isinstance(slc, long):
        slices[index] = slice(int(slc), int(slc)+1, 1)
      else:
        start = 0 if slc.start is None else clamp(slc.start, 0, maxsize[index])
        end = maxsize[index] if slc.stop is None else clamp(slc.stop, 0, maxsize[index])
        step = 1 if slc.step is None else slc.step

        slices[index] =  slice(start, end, step)

    minpt = Vec3(*[ slc.start for slc in slices ]) * self.downsample_ratio
    maxpt = Vec3(*[ slc.stop for slc in slices ]) * self.downsample_ratio
    steps = Vec3(*[ slc.step for slc in slices ])

    minpt += self.voxel_offset * self.downsample_ratio
    maxpt += self.voxel_offset * self.downsample_ratio

    savedir = os.path.join(lib.COMMON_STAGING_DIR, 'gcloud', self.dataset_name, self.layer, str(self.mip))

    return self._cutout(
      xmin=minpt.x, xmax=maxpt.x, xstep=steps.x,
      ymin=minpt.y, ymax=maxpt.y, ystep=steps.y,
      zmin=minpt.z, zmax=maxpt.z, zstep=steps.z,
      savedir=( savedir if self.cache_files else None ),
    )

  def _cutout(self, xmin, xmax, ymin, ymax, zmin, zmax, xstep=1, ystep=1, zstep=1, savedir=None):

    requested_bbox = Bbox(Vec3(xmin, ymin, zmin), Vec3(xmax, ymax, zmax)) / self.downsample_ratio
    volume_bbox = Bbox.from_vec(self.shape) # volume size in voxels
    volume_bbox += self.voxel_offset

    realized_bbox = requested_bbox.fit_to_chunk_size(self.underlying)
    realized_bbox = Bbox.clamp(requested_bbox, volume_bbox)
    
    cloudpaths = self.__cloudpaths(realized_bbox, volume_bbox, self.key, self.underlying)

    renderbuffer = np.zeros(shape=realized_bbox.size3(), dtype=self.data_type)

    files = lib.gcloudFileIterator(cloudpaths, savedir, use_ls=self.use_ls, compress=(self.encoding == 'raw'))

    for filehandle in tqdm(files, total=len(cloudpaths), desc="Rendering Image"):
      bbox = Bbox.from_filename(filehandle.name)

      img3d = self.__decode(filehandle.read(), bbox.size3())
      
      start = bbox.minpt - realized_bbox.minpt
      end = min2(start + self.underlying, renderbuffer.shape )
      delta = min2(end - start, img3d.shape)

      end = start + delta

      renderbuffer[ start.x:end.x, start.y:end.y, start.z:end.z ] = img3d[:delta.x,:delta.y,:delta.z]

    global_deltas = realized_bbox - Bbox.clamp(requested_bbox, volume_bbox)
    ld = global_deltas.minpt # low delta
    hd = realized_bbox.maxpt - global_deltas.maxpt # high delta

    renderbuffer = renderbuffer[ ld.x:hd.x:xstep, ld.y:hd.y:ystep, ld.z:hd.z:zstep ] 

    return VolumeCutout(
      buf=renderbuffer,
      dataset_name=self.dataset_name,
      layer=self.layer,
      mip=self.mip,
      layer_type=self.layer_type,
      bounds=realized_bbox,
    )

  def __decode(self, filedata, shape):
    if len(filedata) == 0:
      return np.zeros(shape=shape, dtype=self.data_type)
    elif self.encoding == 'jpeg':
      return neuroglancer.chunks.decode_jpeg(filedata, shape=shape, dtype=self.data_type)
    elif self.encoding == 'raw':
      return neuroglancer.chunks.decode_raw(filedata, shape=shape, dtype=self.data_type)
    else:
      raise NotImplementedError(encoding)

  def __cloudpaths(self, bbox, volume_bbox, key, chunk_size):
    def cloudpathgenerator():
      resolution_cloudpath = os.path.join(self.base_cloudpath, self.layer, key)
        
      for x,y,z in xyzrange( bbox.minpt, bbox.maxpt, chunk_size ):
        highpt = min2(Vec3(x,y,z) + chunk_size, volume_bbox.maxpt)
        filename = "{}-{}_{}-{}_{}-{}".format(
          x, highpt.x,
          y, highpt.y, 
          z, highpt.z
        )

        yield os.path.join(resolution_cloudpath, filename)

    return [ path for path in cloudpathgenerator() ] 



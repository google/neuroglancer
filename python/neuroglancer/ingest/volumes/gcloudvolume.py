import os
import json
import re

import numpy as np
from tqdm import tqdm

import neuroglancer
import neuroglancer.ingest.lib as lib
from neuroglancer.ingest.lib import clamp, xyzrange, Vec, Vec3, Bbox, min2, max2, Storage
from neuroglancer.ingest.volumes import Volume, VolumeCutout, generate_slices
from google.cloud import storage as gstorage

class GCloudVolume(Volume):
  def __init__(self, dataset_name, layer, mip=0, info=None, cache_files=True, use_ls=False, use_secrets=False):
    super(self.__class__, self).__init__()

    # You can access these two with properties
    self._dataset_name = dataset_name
    self._layer = layer

    self.mip = mip
    
    self.cache_files = cache_files
    self.use_ls = use_ls
    self.use_secrets = use_secrets

    self._uncommitted_changes = []

    if info is None:
      self.refreshInfo()
    else:
      self.info = info

    try:
      self.mip = self.available_mips[self.mip]
    except:
      raise Exception("MIP {} has not been generated.".format(self.mip))

  @classmethod
  def create_new_info(cls, num_channels, layer_type, data_type, encoding, resolution, voxel_offset, volume_size, mesh=False, chunk_size=[64,64,64]):
    info = {
      "num_channels": int(num_channels),
      "type": layer_type,
      "data_type": data_type,
      "scales": [{
        "encoding": encoding,
        "chunk_sizes": [chunk_size],
        "key": "_".join(map(str, resolution)),
        "resolution": list(resolution),
        "voxel_offset": list(voxel_offset),
        "size": list(volume_size),
      }],
    }

    if mesh:
      info['mesh'] = 'mesh'

    return info

  @classmethod
  def from_cloudpath(cls, cloudpath, mip=0, *args, **kwargs):
    # e.g. gs://neuroglancer/DATASET/LAYER/info
    match = re.match(r'(?:gs://)?([\d\w_\.\-]+)/([\d\w_\.\-]+)/([\d\w_\.\-]+)/?(?:info)?', cloudpath)
    bucket, dataset_name, layer = match.groups()

    return GCloudVolume(dataset_name, layer, mip, *args, **kwargs)

  def refreshInfo(self):
    blob = self.__getInfoBlob()
    self.info = json.loads(blob.download_as_string())
    return self

  def commitInfo(self):
    info_path = self.__getInfoPath()
    lib.set_blob(info_path, json.dumps(self.info), 'application/json')
    return self

  def __getInfoPath(self):
    return os.path.join(self.dataset_name, self.layer, 'info')

  def __getInfoBlob(self):
    info_path = self.__getInfoPath()
    return lib.get_blob(info_path, use_secrets=self.use_secrets)

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
    size = self.mip_volume_size(mip)
    return Vec(size.x, size.y, size.z, self.num_channels)

  @property
  def volume_size(self):
    return self.mip_volume_size(self.mip)

  def mip_volume_size(self, mip):
    return Vec(*self.info['scales'][mip]['size'])

  @property
  def available_mips(self):
    return range(len(self.info['scales']))

  @property
  def layer_type(self):
    return self.info['type']

  @property
  def dtype(self):
    return self.data_type

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
    return int(self.info['num_channels'])

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
    shape = self.mip_volume_size(mip)
    return Bbox( offset, offset + shape )

  def slices_from_global_coords(self, slices):
    maxsize = list(self.mip_volume_size(0))
    maxsize.append(self.num_channels)

    slices = generate_slices(slices, maxsize)[:3]
    lower = Vec(*map(lambda x: x.start, slices))
    upper = Vec(*map(lambda x: x.stop, slices))
    step = Vec(*map(lambda x: x.step, slices))

    lower /= self.downsample_ratio
    upper /= self.downsample_ratio

    signs = step / np.absolute(step)
    step = signs * max2(np.absolute(step / self.downsample_ratio), Vec(1,1,1))
    step = Vec(*np.round(step))

    return [
      slice(lower.x, upper.x, step.x),
      slice(lower.y, upper.y, step.y),
      slice(lower.z, upper.z, step.z)
    ]

  def addScale(self, factor):
    # e.g. {"encoding": "raw", "chunk_sizes": [[64, 64, 64]], "key": "4_4_40", 
    # "resolution": [4, 4, 40], "voxel_offset": [0, 0, 0], 
    # "size": [2048, 2048, 256]}
    fullres = self.info['scales'][0]


    # If the voxel_offset is not divisible by the ratio,
    # zooming out will slightly shift the data.
    # Imagine the offset is 10
    #    the mip 1 will have an offset of 5
    #    the mip 2 will have an offset of 2 instead of 2.5 
    #        meaning that it will be half a pixel to the left
    
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
    
    maxsize = list(self.volume_size)
    maxsize.append(self.num_channels)

    slices = generate_slices(slices, maxsize)

    channel_slice = slices.pop()

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
      channel_slice=channel_slice,
      savedir=( savedir if self.cache_files else None ),
    )

  def _cutout(self, xmin, xmax, ymin, ymax, zmin, zmax, xstep=1, ystep=1, zstep=1, channel_slice=slice(None), savedir=None):
    requested_bbox = Bbox(Vec3(xmin, ymin, zmin), Vec3(xmax, ymax, zmax)) / self.downsample_ratio

    realized_bbox = requested_bbox.expand_to_chunk_size(self.underlying, offset=self.voxel_offset)
    realized_bbox = Bbox.clamp(realized_bbox, self.bounds)

    cloudpaths = self.__cloudpaths(realized_bbox, self.bounds, self.key, self.underlying)

    def multichannel_shape(bbox):
      shape = bbox.size3()
      return (shape[0], shape[1], shape[2], self.num_channels)

    renderbuffer = np.zeros(shape=multichannel_shape(realized_bbox), dtype=self.data_type)

    compress = (self.layer_type == 'segmentation' and self.cache_files) # sometimes channel images are raw encoded too
    files = lib.gcloudFileIterator(cloudpaths, savedir, use_ls=self.use_ls, compress=compress)

    for filehandle in tqdm(files, total=len(cloudpaths), desc="Rendering Image"):
      bbox = Bbox.from_filename(filehandle.name)

      img3d = neuroglancer.chunks.decode(
        filehandle.read(), self.encoding, multichannel_shape(bbox), self.data_type
      )
      
      start = bbox.minpt - realized_bbox.minpt
      end = min2(start + self.underlying, renderbuffer.shape[:3] )
      delta = min2(end - start, img3d.shape[:3])

      end = start + delta

      renderbuffer[ start.x:end.x, start.y:end.y, start.z:end.z, : ] = img3d[ :delta.x, :delta.y, :delta.z, : ]

    requested_bbox = Bbox.clamp(requested_bbox, self.bounds)
    lp = requested_bbox.minpt - realized_bbox.minpt # low realized point
    hp = lp + requested_bbox.size3()

    renderbuffer = renderbuffer[ lp.x:hp.x:xstep, lp.y:hp.y:ystep, lp.z:hp.z:zstep, channel_slice ] 

    return VolumeCutout.from_volume(self, renderbuffer, realized_bbox)
  
  def __setitem__(self, slices, value):
    self._uncommitted_changes.append( (slices, value) )

  def commitData(self):
    allslices = map(lambda x: x[0], self._uncommitted_changes)
    allslices = [ generate_slices(slices, self.volume_size) for slices in allslices ]
    allboxes = map(Bbox.from_slices, allslices)
    
    big_bbox = Bbox.expand(*allboxes)
    subvol = self[ big_bbox.to_slices() ]

    for slcs, img in self._uncommitted_changes:
      bbox = Bbox.from_slices(slcs) - big_bbox.minpt
      subvol[ bbox.to_slices() ] = img 

    self.upload_image(subvol, big_bbox.minpt)
    self._uncommitted_changes = []

  def upload_image(self, img, offset):
    shape = Vec(*img.shape)[:3]
    offset = Vec(*offset)[:3]

    bounds = Bbox( offset, shape + offset)
    bounds = Bbox.clamp(bounds, self.bounds)
    # bounds = bounds.shrink_to_chunk_size( self.underlying )

    img_offset = bounds.minpt - offset
    img_end = Vec.clamp(bounds.size3() + img_offset, Vec(0,0,0), shape)

    def generate_chunks():
      for startpt in xyzrange( img_offset, img_end, self.underlying ):
        endpt = min2(startpt + self.underlying, shape)
        chunkimg = img[ startpt.x:endpt.x, startpt.y:endpt.y, startpt.z:endpt.z ]
        yield chunkimg, startpt + bounds.minpt, endpt + bounds.minpt

    compress = (self.layer_type == 'segmentation')
    storage = Storage(self.dataset_name, self.layer, compress)

    for imgchunk, spt, ept in generate_chunks():
      if np.array_equal(spt, ept):
          continue

      spt = spt.astype(int)
      ept = ept.astype(int)

      # handle the edge of the dataset
      clamp_ept = min2(ept, self.bounds.maxpt)
      delta = ept - clamp_ept
      newimgchunk = imgchunk[ :-delta.x, :-delta.y, :-delta.z, : ]

      filename = "{}-{}_{}-{}_{}-{}".format(
          spt.x, clamp_ept.x,
          spt.y, clamp_ept.y, 
          spt.z, clamp_ept.z
        )

      encoded = neuroglancer.chunks.encode(imgchunk, self.encoding)
      storage.add_file(filename, encoded)

    storage.flush(self.key)

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



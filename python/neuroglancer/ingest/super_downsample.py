import operator

import numpy as np
from tqdm import tqdm
from PIL import Image

from neuroglancer import chunks, downsample, downsample_scales
from volumes import GCloudVolume
from lib import Storage, xyzrange, Vec3, min2, mkdir

def generate_chunks(img, chunk_sizes, voxel_offset):
  chunk_sizes = Vec3(*chunk_sizes)
  volume_size = Vec3(*img.shape)

  for startpt in xyzrange( voxel_offset, volume_size, chunk_sizes ):
    endpt = min2(startpt + chunk_sizes, volume_size)

    chunkimg = img[ startpt.x:endpt.x, startpt.y:endpt.y, startpt.z:endpt.z ]

    filename = '{}-{}_{}-{}_{}-{}'.format(
      startpt.x, endpt.x,
      startpt.y, endpt.y,
      startpt.z, endpt.z
    ) 

    yield chunkimg, filename 

def generate_downsamples(dataset_name, layer, starting_mip=-1):
  vol = GCloudVolume(dataset_name, layer, mip=starting_mip)

  fullscales = downsample_scales.compute_near_isotropic_downsampling_scales(
    size=vol.shape,
    voxel_size=vol.resolution,
    dimensions_to_downsample=[0,1,2],
    # This expression computes the maximum number of downsamples that can be
    # extracted. That is, how many times can we downsize and still be greater 
    # than or equal to the underlying chunk size? 
    max_downsampling=int(reduce(operator.mul, vol.shape / vol.underlying )),
  )

  fullscales = [ Vec3(*scale) for scale in fullscales ] 
  scales = []
  for i in xrange(1, len(fullscales)):
    scales.append( fullscales[i] / fullscales[i - 1]  )

  fullscales = fullscales[1:] # omit (1,1,1)

  compress = (vol.layer_type == 'segmentation')
  storage = Storage(dataset_name, layer, compress)
  downsampled_img = vol[:,:,:]

  if vol.layer_type == 'image':
    downsamplefn = downsample.downsample_with_averaging
  elif vol.layer_type == 'segmentation':
    downsamplefn = downsample.downsample_segmentation
  else:
    downsamplefn = downsample.downsample_with_striding

  for totalfactor3, factor3 in zip(fullscales, scales):
    scale = vol.addScale(totalfactor3 * vol.downsample_ratio) # total downsample ratio for new scale
    downsampled_img = downsamplefn(downsampled_img, factor3)

    image_chunks = generate_chunks(downsampled_img, vol.underlying, vol.voxel_offset)

    for img_chunk, filename in tqdm(image_chunks, desc="{} Chunks".format(totalfactor3)):
      if scale["encoding"] == "jpeg":
        encoded = chunks.encode_jpeg(img_chunk)
      elif scale["encoding"] == "npz":
        encoded = chunks.encode_npz(img_chunk)
      elif scale["encoding"] == "raw":
        encoded = chunks.encode_raw(img_chunk)
      else:
        raise NotImplemented

      storage.add_file(filename, encoded)

    storage.flush(scale['key'])

    vol.commit()

def generate_jpegs(dataset_name, layer, mip):
  """You can use and modify this function to visualize the data you pull down"""
  vol = GCloudVolume(dataset_name, layer, mip=mip)

  zslice = slice(0, 100, 1)

  renderbuffer = vol[:,:,zslice]

  directory = mkdir('./staging/jpegs/')

  print "Saving {} Z-Slices to {}".format(zslice.stop, directory)

  for z in tqdm(xrange(zslice.stop)):
    img = renderbuffer[:,:,z]

    # discovered that downloaded cube is in a weird rotated state.
    # it requires a 90deg counterclockwise rotation on xy plane (leaving z alone)
    # followed by a flip on Y
    img = np.flipud(np.rot90(img, 1)) 
    img = Image.fromarray(img)

    img.save(directory + '{}.jpeg'.format(z), "JPEG")

if __name__ == "__main__":
  dataset = 'snemi3dtest_v0'
  mip = 0

  # generate_jpegs(dataset, 'image', mip)
  generate_downsamples(dataset, 'image', mip)
  # generate_downsamples(dataset, 'segmentation', mip)
  print 'done'

# https://neuromancer-seung-import.appspot.com/#!{'layers':{'image':{'type':'image'_'source':'precomputed://glance://s1_v0/image'}_'segmentation':{'type':'segmentation'_'source':'precomputed://glance://s1_v0/segmentation'}}}








#!/usr/bin/python

"""
WARNING: This script is defunct and broken, but could be revived
if the need arose, though makes more sense to just run
DownsampleTasks.

This script will download an entire layer at a given resolution,
execute downsampling, and upload the results. It generally creates
multiple mip levels from a given layer. Because it downloads everything,
the dataset has to be rather small for it to fit on a single machine.

Example Command:
  python super_downsample.py --image --dataset s1_v0 --mip 4  

"""

from __future__ import print_function

import argparse
import operator
import sys

import numpy as np
from tqdm import tqdm
from PIL import Image

from neuroglancer import chunks, downsample, downsample_scales
from volumes import GCloudVolume
from lib import Storage, xyzrange, Vec3, min2, mkdir

DEFAULT_CHUNK_SIZE = Vec3(2048, 2048, 256)

def generate_big_chunks(vol):
  chunk_sizes = min2(DEFAULT_CHUNK_SIZE, vol.shape)

  for startpt in xyzrange( (0,0,0), vol.shape, chunk_sizes ):
    endpt = min2(startpt + chunk_sizes, vol.shape)
    data = np.zeros(shape=chunk_sizes, dtype=vol.data_type)

    delta = endpt - startpt

    data[ :delta.x, :delta.y, :delta.z ] = vol[ startpt.x:endpt.x, startpt.y:endpt.y, startpt.z:endpt.z ]

    yield data, startpt + vol.voxel_offset, endpt + vol.voxel_offset

def generate_neuroglancer_chunks(img, chunk_sizes):
  chunk_sizes = Vec3(*chunk_sizes)
  volume_size = Vec3(*img.shape)

  for startpt in xyzrange( (0,0,0), volume_size, chunk_sizes ):
    endpt = min2(startpt + chunk_sizes, volume_size)

    chunkimg = img[ startpt.x:endpt.x, startpt.y:endpt.y, startpt.z:endpt.z ]

    yield chunkimg, startpt, endpt 

def generate_downsamples(dataset_name, layer, starting_mip=-1):
  vol = GCloudVolume(dataset_name, layer, mip=starting_mip, use_ls=False)

  def get_factors(chunk_size):
    fullscales = downsample_scales.compute_xy_plane_downsampling_scales(
      size=chunk_size,
      voxel_size=vol.resolution,
      # # This expression computes the maximum number of downsamples that can be
      # # extracted. That is, how many times can we downsize and still be greater 
      # # than or equal to the underlying chunk size? 
      # max_downsampling=int(reduce(operator.mul, chunk_size / vol.underlying )),
    )

    fullscales = [ Vec3(*scale) for scale in fullscales ] 
    deltas = []
    for i in xrange(1, len(fullscales)):
      deltas.append( fullscales[i] / fullscales[i - 1]  )

    return deltas, fullscales[1:] # omit (1,1,1)

  compress = (vol.layer_type == 'segmentation')
  storage = Storage(dataset_name, layer, compress)

  scales, fullscales = get_factors( min2(DEFAULT_CHUNK_SIZE, vol.shape) )
  for totalfactor3 in fullscales:
    vol.addScale(totalfactor3 * vol.downsample_ratio) # total downsample ratio for new scale

  vol.commit()

  for bigchunk, bigstart, bigend in generate_big_chunks(vol):
    scales, fullscales = get_factors(bigchunk.shape)

    current_mip = vol.mip
    downsampled_img = bigchunk

    multiplied_factor = Vec3(1,1,1)

    for factor3, totalfactor3 in tqdm(zip(scales, fullscales), desc="Generating MIP " + str(current_mip + 1)):
      current_mip += 1

      multiplied_factor *= factor3

      downsampled_img = downsample.method(vol.layer_type)(downsampled_img, factor3)
      image_chunks = generate_neuroglancer_chunks(downsampled_img, vol.underlying)

      bounds = vol.mip_bounds(current_mip)

      for img_chunk, chunkstart, chunkend in tqdm(image_chunks, desc="{} Chunks".format(totalfactor3)):
        startpt = (bigstart / multiplied_factor) + chunkstart
        endpt = (bigstart / multiplied_factor) + chunkend

        startpt = min2(startpt, bounds.maxpt)
        endpt = min2(endpt, bounds.maxpt)

        if np.array_equal(startpt, endpt):
          continue

        filename = '{}-{}_{}-{}_{}-{}'.format(
          startpt.x, endpt.x,
          startpt.y, endpt.y,
          startpt.z, endpt.z
        ) 

        encoded = chunks.encode(img_chunk, vol.mip_encoding(current_mip))

        storage.add_file(filename, encoded)

      storage.flush(vol.mip_key(current_mip))

def generate_jpegs(dataset_name, layer, mip):
  """You can use and modify this function to visualize the data you pull down"""
  vol = GCloudVolume(dataset_name, layer, mip=mip)

  zslice = slice(0, 100, 1)

  renderbuffer = vol[:,:,zslice]

  directory = mkdir('./staging/jpegs/')

  print("Saving {} Z-Slices to {}".format(zslice.stop, directory))

  for z in tqdm(xrange(zslice.stop)):
    img = renderbuffer[:,:,z]

    # discovered that downloaded cube is in a weird rotated state.
    # it requires a 90deg counterclockwise rotation on xy plane (leaving z alone)
    # followed by a flip on Y
    img = np.flipud(np.rot90(img, 1)) 
    img = Image.fromarray(img)

    img.save(directory + '{}.jpeg'.format(z), "JPEG")

if __name__ == "__main__":
  parser = argparse.ArgumentParser(description='Generate additional MIP levels for neuroglancer layers.')
  parser.add_argument('--layer', dest='layer', action='store',
                    default=None, 
                    help='Name of layer in dataset.')

  parser.add_argument('--image', dest='image', action='store_true',
                    default=False, 
                    help='Select image layer in dataset.')

  parser.add_argument('--segmentation', dest='segmentation', action='store_true',
                    default=False, 
                    help='Select segmentation layer in dataset.')

  parser.add_argument('--affinity', dest='affinity', action='store_true',
                    default=False, 
                    help='Select affinity layer in dataset.')

  parser.add_argument('--jpeg', dest='jpeg', action='store_true',
                    default=False, 
                    help='Just generate Z slice images for debugging.')

  parser.add_argument('--dataset', dest='dataset', action='store',
                    help='Name of dataset in neuroglancer bucket.', required=True)

  parser.add_argument('--mip', dest='mip', action='store',
                  help='Which mip level to source from counting from 0. -1 means use the top one.', required=True)  

  args = parser.parse_args()
  dataset = args.dataset
  mip = int(args.mip)

  layer = args.layer
  jpeg = args.jpeg

  if jpeg:
    generate_jpegs(dataset, 'image', mip)
    sys.exit()

  if layer is not None:
    generate_downsamples(dataset, layer, mip)

  if args.image:
    generate_downsamples(dataset, 'image', mip)

  if args.segmentation:
    generate_downsamples(dataset, 'segmentation', mip)

  if args.affinity:
    print("affinity layers are not yet supported.")

  print('done')

# https://neuromancer-seung-import.appspot.com/#!{'layers':{'image':{'type':'image'_'source':'precomputed://glance://s1_v0/image'}_'segmentation':{'type':'segmentation'_'source':'precomputed://glance://s1_v0/segmentation'}}}








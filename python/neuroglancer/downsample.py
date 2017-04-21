# @license
# Copyright 2017 The Neuroglancer Authors
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import division

import math
import operator
import numpy as np

def method(layer_type):
  if layer_type == 'image':
    return downsample_with_averaging
  elif layer_type == 'segmentation':
    return downsample_segmentation
  else:
    return downsample_with_striding 

def odd_to_even(image):
  """
  To facilitate 2x2 downsampling segmentation, change an odd sized image into an even sized one.
  Works by mirroring the starting 1 pixel edge of the image on odd shaped sides.

  e.g. turn a 3x3x5 image into a 4x4x5 (the x and y are what are getting downsampled)
  
  For example: [ 3, 2, 4 ] => [ 3, 3, 2, 4 ] which is now super easy to downsample.

  """
  if len(image.shape) == 3:
    image = image[ :,:,:, np.newaxis ]

  shape = np.array(image.shape)

  offset = (shape % 2)[:2] # x,y offset
  
  if not np.any(offset): # any non-zeros
    return image

  oddshape = image.shape[:2] + offset
  oddshape = np.append(oddshape, shape[2:])
  oddshape = oddshape.astype(int)

  newimg = np.empty(shape=oddshape, dtype=image.dtype)

  ox,oy = offset
  sx,sy,sz,ch = oddshape

  newimg[0,0,0,:] = image[0,0,0,:] # corner
  newimg[ox:sx,0,0,:] = image[:,0,0,:] # x axis line
  newimg[0,oy:sy,0,:] = image[0,:,0,:] # y axis line 
  newimg[0,0,:,:] = image[0,0,:,:] # vertical line

  newimg[ox:,oy:,:,:] = image[:,:,:,:]
  newimg[ox:sx,0,:,:] = image[:,0,:,:]
  newimg[0,oy:sy,:,:] = image[0,:,:,:]

  return newimg

def scale_series_to_downsample_factors(scales):
  fullscales = [ np.array(scale) for scale in scales ] 
  factors = []
  for i in xrange(1, len(fullscales)):
    factors.append( fullscales[i] / fullscales[i - 1]  )
  return [ factor.astype(int) for factor in factors ]

def downsample_with_averaging(array, factor):
    """Downsample x by factor using averaging.

    @return: The downsampled array, of the same type as x.
    """
    if len(array.shape) == 4 and len(factor) == 3:
      factor = list(factor) + [ 1 ] # don't mix channels

    factor = tuple(factor)
    output_shape = tuple(int(math.ceil(s / f)) for s, f in zip(array.shape, factor))
    temp = np.zeros(output_shape, float)
    counts = np.zeros(output_shape, np.int)
    for offset in np.ndindex(factor):
        part = array[tuple(np.s_[o::f] for o, f in zip(offset, factor))]
        indexing_expr = tuple(np.s_[:s] for s in part.shape)
        temp[indexing_expr] += part
        counts[indexing_expr] += 1
    return np.cast[array.dtype](temp / counts)

def downsample_segmentation(data, factor):
  factor = np.array(factor)
  if np.array_equal(factor, np.array([1,1,1])):
    return data

  is_pot = lambda x: (x != 0) and not (x & (x - 1)) # is power of two
  is_twod_pot_downsample = np.any(factor == 1) and is_pot(reduce(operator.mul, factor))
  
  if not is_twod_pot_downsample:
    return downsample_with_striding(data, tuple(factor))

  preserved_axis = np.where(factor == 1)[0][0] # e.g. 0, 1, 2

  shape3d = np.array(data.shape[:3])

  modulo_shape = shape3d % 2
  modulo_shape[preserved_axis] = 0
  has_even_dims = sum(modulo_shape) == 0 

  # algorithm is written for xy plane, so
  # switch other orientations to that plane, 
  # do computation and switch back.
  data = np.swapaxes(data, preserved_axis, 2)

  if not has_even_dims:
    data = odd_to_even(data)
    shape3d = np.array(data.shape[:3])

  output = np.zeros(
    shape=( int(data.shape[0] / 2), int(data.shape[1] / 2), data.shape[2], data.shape[3]), 
    dtype=data.dtype
  )
  for z in xrange(data.shape[2]):
    output[:,:,z,:] = downsample_segmentation_2D_4x(data[:,:,z,:])
  
  factor = factor / 2
  factor[preserved_axis] = 1

  output = np.swapaxes(output, preserved_axis, 2)
  
  return downsample_segmentation(output, factor)

def downsample_segmentation_2D_4x(data):
  """Vectorized implementation of downsampling a 2D 
  image by 2 on each side using the COUNTLESS algorithm."""
  sections = []

  # allows us to prevent losing 1/2 a bit of information 
  # at the top end by using a bigger type. Without this 255 is handled incorrectly.
  data, upgraded = upgrade_type(data) 

  data = data + 1 # don't use +=, it will affect the original data.

  factor = (2,2)
  for offset in np.ndindex(factor):
    part = data[tuple(np.s_[o::f] for o, f in zip(offset, factor))]
    sections.append(part)

  a, b, c, d = sections

  ab_ac = a * ((a == b) | (a == c)) # ab := a if a == b else 0 and so on for ac, bc
  bc = b * (b == c)

  a = ab_ac | bc # ab or ac or bc

  result = a + (a == 0) * d - 1 # a or d - 1

  if upgraded:
    return downgrade_type(result)

  return result

def upgrade_type(arr):
  dtype = arr.dtype

  if dtype == np.uint8:
    return arr.astype(np.uint16), True
  elif dtype == np.uint16:
    return arr.astype(np.uint32), True
  elif dtype == np.uint32:
    return arr.astype(np.uint64), True

  return arr, False
  
def downgrade_type(arr):
  dtype = arr.dtype

  if dtype == np.uint64:
    return arr.astype(np.uint32)
  elif dtype == np.uint32:
    return arr.astype(np.uint16)
  elif dtype == np.uint16:
    return arr.astype(np.uint8)
  
  return arr

def downsample_with_striding(array, factor): 
    """Downsample x by factor using striding.

    @return: The downsampled array, of the same type as x.
    """
    return array[tuple(np.s_[::f] for f in factor)]

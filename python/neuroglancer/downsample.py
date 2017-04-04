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
import numpy as np

def method(layer_type):
  if layer_type == 'image':
    return downsample_with_averaging
  elif layer_type == 'segmentation':
    return downsample_segmentation
  else:
    return downsample_with_striding 

def downsample_with_averaging(array, factor):
    """Downsample x by factor using averaging.

    @return: The downsampled array, of the same type as x.
    """
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
  factor = tuple(factor)
  if factor == (1,1,1):
    return data

  is_pot = lambda x: (x != 0) and not (x & (x - 1)) # is power of two
  is_twod_pot_downsample = (factor[2] == 1) and (factor[1] == factor[0]) and is_pot(factor[0])
  has_even_dims = (data.shape[0] % 2 == 0) and (data.shape[1] % 2 == 0)
  if not is_twod_pot_downsample or not has_even_dims:
    return downsample_with_striding(data, factor)
  output = np.zeros(
    shape=( data.shape[0] / 2, data.shape[1] / 2, data.shape[2], data.shape[3]), 
    dtype=data.dtype
  )
  for z in xrange(data.shape[2]):
    output[:,:,z,:] = downsample_segmentation_2D_4x(data[:,:,z,:])
  factor = (factor[0] / 2, factor[1] / 2, 1)
  return downsample_segmentation(output, factor)

def downsample_segmentation_2D_4x(data):
  """Vectorized implementation of downsampling a 2D 
  image by 2 on each side using the COUNTLESS algorithm."""
  sections = []

  # This algorithm doesn't handle 0 correctly, so add one now and take it away later
  # It's essentially a tradeoff between the low and high end of the integer.
  data = data + 1 # don't use +=, it will affect the original data.

  factor = (2,2)
  for offset in np.ndindex(factor):
    part = data[tuple(np.s_[o::f] for o, f in zip(offset, factor))]
    sections.append(part)

  a, b, c, d = sections

  ab_ac = a * ((a == b) | (a == c)) # ab := a if a == b else 0 and so on for ac, bc
  bc = b * (b == c)

  a = ab_ac | bc # ab or ac or bc

  return a + (a == 0) * d - 1 # a or d + 1
  
def downsample_with_striding(array, factor): 
    """Downsample x by factor using striding.

    @return: The downsampled array, of the same type as x.
    """
    return array[tuple(np.s_[::f] for f in factor)]

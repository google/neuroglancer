# @license
# Copyright 2016 Google Inc.
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
import operator

from downsample_countless import downsample_with_mode_2D, odd_to_even


def downsample_with_averaging(array, factor):
    """Downsample x by factor using averaging.

    @return: The downsampled array, of the same type as x.
    """
    factor = tuple(factor)
    output_shape = tuple(int(math.ceil(s / f)) for s, f in zip(array.shape, factor))
    temp = np.zeros(output_shape, dtype=np.float32)
    counts = np.zeros(output_shape, np.int)
    for offset in np.ndindex(factor):
        part = array[tuple(np.s_[o::f] for o, f in zip(offset, factor))]
        indexing_expr = tuple(np.s_[:s] for s in part.shape)
        temp[indexing_expr] += part
        counts[indexing_expr] += 1
    return np.cast[array.dtype](temp / counts)


def downsample_with_striding(array, factor):
    """Downsample x by factor using striding.

    @return: The downsampled array, of the same type as x.
    """
    return array[tuple(np.s_[::f] for f in factor)]


def downsample_segmentation(data, factor):
  """Downsample x by factor by picking the most frequent value within a
  2x2 square for each 2D image within a 3D stack if factor
  is specified such that a power of two downsampling is possible.

  Otherwise, downsample by striding.

  If factor has fewer parameters than data.shape, the remainder
  are assumed to be 1.

  @return: The downsampled array, of the same type as x.
  """
  factor = np.array(factor)
  if np.all(np.array(factor, int) == 1):
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
    output[:,:,z,:] = downsample_with_mode_2D(data[:,:,z,:])
  
  factor = factor / 2
  factor[preserved_axis] = 1

  output = np.swapaxes(output, preserved_axis, 2)
  
  return downsample_segmentation(output, factor)

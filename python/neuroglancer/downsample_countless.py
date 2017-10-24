# @license
# Copyright Seung Lab
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

import numpy as np

def downsample_with_mode_2D(data):
  """
  Vectorized implementation of downsampling a 2D labeled
  image by 2 on each side using the COUNTLESS algorithm.

  This chooses the mode of each 2x2 block within an image.

  Learn more:
  https://medium.com/@willsilversmith/countless-high-performance-2x-downsampling-of-labeled-images-using-python-and-numpy-e70ad3275589

  Requires:
    data: Even dimensioned 2D uint numpy array.

  Returns: numpy array with each dimension halved (3/4 total size reduction).
  """
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

def odd_to_even(image):
  """
  To facilitate 2x2 downsampling segmentation, change an odd 
  sized image into an even sized one. Mirror the 1 pixel edge 
  of the image on odd shaped sides.

  e.g. turn a 3x3x5 image into a 4x4x5 (x and y are downsampled)
  
  For example: [ 3, 2, 4 ] => [ 3, 3, 2, 4 ] 
    Which is now easy to downsample to [ 3 ]
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
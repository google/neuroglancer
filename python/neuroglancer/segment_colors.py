# @license
# Copyright 2017 Google Inc.
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

import math

def hash_function(state,value):
    """ Python implementation of hashCombine() function
    in src/neuroglancer/gpu_hash/hash_function.ts,
    a modified murmur hash
    """
    k1 = 0xcc9e2d51
    k2 = 0x1b873593
    state = state & 0xffffffff
    value = (value * k1) & 0xffffffff
    value = ((value << 15) | value >> 17) & 0xffffffff
    value = (value * k2) & 0xffffffff
    state = (state ^ value) & 0xffffffff
    state = (( state << 13) | state >> 19) & 0xffffffff
    state = (( state * 5) + 0xe6546b64) & 0xffffffff
    return state

def hsv_to_rgb(h,s,v):
    """ Convert H,S,V values to RGB values.
    Python implementation of hsvToRgb in src/neuroglancer/util/colorspace.ts """
    h*=6
    hue_index = math.floor(h)
    remainder = h - hue_index
    val1 = v*(1-s)
    val2 = v*(1-(s*remainder))
    val3 = v*(1-(s*(1-remainder)))
    hue_remainder = hue_index % 6
    if hue_remainder == 0:
        return (v,val3,val1)
    elif hue_remainder == 1:
        return (val2,v,val1)
    elif hue_remainder == 2:
        return (val1,v,val3)
    elif hue_remainder == 3:
        return (val1,val2,v)
    elif hue_remainder == 4:
        return (val3,val1,v)
    elif hue_remainder == 5: 
        return (v,val1,val2)   

def pack_color(rgb_vec):
    """ Returns an integer formed
    by concatenating the channels of the input color vector.
    Python implementation of packColor in src/neuroglancer/util/color.ts
    """
    result = 0
    for i in range(len(rgb_vec)):
        result = ((result << 8) & 0xffffffff) + min(255,max(0,round(rgb_vec[i]*255)))
    return result

def hex_string_from_segment_id(color_seed,segment_id):
    """ Return the hex color string for a segment
    given a color seed and the segment id """
    segment_id = int(segment_id) # necessary since segment_id is 64 bit originally 
    result = hash_function(state=color_seed,value=segment_id)
    newvalue = segment_id >> 32
    result2 = hash_function(state=result,value=newvalue)
    c0 = (result2 & 0xFF) / 255.
    c1 = ((result2 >> 8) & 0xFF) / 255.;
    h = c0
    s =  0.5 + 0.5 * c1
    v = 1.0
    rgb=hsv_to_rgb(h,s,v)
    packed_color = pack_color(rgb_vec=rgb)
    hex_string = format(packed_color, 'x')
    """ Zero pad the hex string if less than 6 characeters """
    if len(hex_string) < 6:
        hex_string = '0'*(6-len(hex_string)) + hex_string
    hex_string = '#' + hex_string
    return hex_string
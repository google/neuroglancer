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

import operator
from . import LocalVolume

class LocalMultiscaleVolume(LocalVolume):
    """A layer that provides local volume data on different scales.
    Mimics a LocalVolume.

    @param volume_layers: List of LocalVolume sources to combine into
        a LocalMultiscaleVolume.
    """
    def __init__(self, volume_layers):
        super(LocalVolume, self).__init__()
        self.min_voxel_size = min(
            [
                tuple(l.voxel_size)
                for l in volume_layers
            ]
        )
        self.volume_layers = {
            tuple(map(operator.truediv, l.voxel_size, self.min_voxel_size)): l
            for l in volume_layers
        }

    @property
    def volume_type(self):
        return self.volume_layers[(1,1,1)].volume_type

    @property
    def token(self):
        return self.volume_layers[(1,1,1)].token

    def info(self):
        scales = []

        for scale, layer in sorted(self.volume_layers.items()):
            # TODO: support 2D
            scale_info = layer.info()['threeDimensionalScales'][0]
            scale_info['key'] = ','.join('%d'%s for s in scale)
            scales.append(scale_info)

        reference_layer = self.volume_layers[(1, 1, 1)]

        info = {
            'volumeType': reference_layer.volume_type,
            'dataType': reference_layer.data_type,
            'encoding': reference_layer.encoding,
            'numChannels': reference_layer.num_channels,
            'generation': reference_layer.change_count,
            'threeDimensionalScales': scales
        }

        return info

    def get_encoded_subvolume(self, data_format, start, end, scale_key='1,1,1'):
        scale = tuple(int(s) for s in scale_key.split(','))
        return self.volume_layers[scale].get_encoded_subvolume(
            data_format,
            start,
            end,
            scale_key='1,1,1')

    def get_object_mesh(self, object_id):
        return self.volume_layers[(1,1,1)].get_object_mesh(object_id)

    def invalidate(self):
        return self.volume_layers[(1,1,1)].invalidate()

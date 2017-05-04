import re
import subprocess
from tempfile import NamedTemporaryFile
import os

import h5py
import numpy as np

from neuroglancer.pipeline import Storage, Precomputed, RegisteredTask

class WatershedTask(RegisteredTask):

    def __init__(self, chunk_position, crop_position,
                 layer_path_affinities, layer_path_segmentation,
                 high_threshold, low_threshold, merge_threshold, 
                 merge_size, dust_size):
        super(WatershedTask, self).__init__(chunk_position, crop_position,
                           layer_path_affinities, layer_path_segmentation,
                           high_threshold, low_threshold, merge_threshold, 
                           merge_size, dust_size)

        self.chunk_position = chunk_position
        self.crop_position = crop_position
        self.layer_path_affinities = layer_path_affinities
        self.layer_path_segmentation = layer_path_segmentation
        self.high_threshold = high_threshold
        self.low_threshold = low_threshold
        self.merge_threshold = merge_threshold
        self.merge_size = merge_size
        self.dust_size = dust_size

    def execute(self):
        self._parse_chunk_position()
        self._parse_crop_position()
        self._download_input_chunk()
        self._run_julia()
        self._upload_chunk()

    def _parse_chunk_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.chunk_position)
        (self._xmin, self._xmax,
         self._ymin, self._ymax,
         self._zmin, self._zmax) = map(int, match.groups())

    def _parse_crop_position(self):
        match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$', self.crop_position)
        (self._cropxmin, self._cropxmax,
         self._cropymin, self._cropymax,
         self._cropzmin, self._cropzmax) = map(int, match.groups())

    def _download_input_chunk(self):
        volume = Precomputed(Storage(self.layer_path_affinities))
        self._data = volume[self._xmin:self._xmax,
                            self._ymin:self._ymax,
                            self._zmin:self._zmax]

        if self._data.dtype == np.uint8:
            self._data = self._data.astype(np.float32) / 255.0

    def _run_julia(self):
        # Too lazy to write a julia wrapper
        with NamedTemporaryFile(delete=True) as input_file:
            with h5py.File(input_file.name,'w') as h5:
                h5.create_dataset('main', data=self._data.T)

            with NamedTemporaryFile(delete=True) as output_file:
            
                current_dir = os.path.dirname(os.path.abspath(__file__))
                subprocess.call(["julia",
                             current_dir +"../../../ext/third_party/watershed/src/cli.jl",
                             input_file.name,
                             output_file.name,
                             str(self.high_threshold),
                             str(self.low_threshold),
                             str(self.merge_threshold),
                             str(self.merge_size),
                             str(self.dust_size)])

                with h5py.File(output_file.name,'r') as h5:
                    self._data = h5['main'][:].T

    def _upload_chunk(self):
        volume = Precomputed(Storage(self.layer_path_segmentation))
        crop_data = self._data[self._cropxmin:self._cropxmax,
                               self._cropymin:self._cropymax,
                               self._cropzmin:self._cropzmax, np.newaxis]
        volume[self._xmin+self._cropxmin: self._xmin + self._cropxmax,
               self._ymin+self._cropymin: self._ymin + self._cropymax,
               self._zmin+self._cropzmin: self._zmin + self._cropzmax] = crop_data
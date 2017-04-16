from collections import namedtuple
import json
import itertools
import sys

import numpy as np

from neuroglancer import chunks

class Precomputed(object):
    Chunk = namedtuple('Chunk',
        ['x_start','x_stop','y_start','y_stop','z_start','z_stop'])

    def __init__(self, storage, scale_idx=0):
        self._storage = storage
        self._download_info()
        self._scale = self.info['scales'][scale_idx]

        # Don't know how to handle more than one
        assert len(self._scale['chunk_sizes']) == 1

    def _download_info(self):
        self.info = json.loads(self._storage.get_file('info'))

    def __getitem__(self, slices):
        """
        It only supports grid aligned slices which
        spans an integer number of chunks.
        """
        new_slices, sub_slices = self._align_slices(slices)

        return_volume = np.empty(
            shape=self._get_slices_shape(new_slices),
            dtype=self.info['data_type'])

        offset =  self._get_offsets(new_slices)
        for c in self._iter_chunks(new_slices):

            file_path = self._chunk_to_file_path(c)
            content = chunks.decode(
                self._storage.get_file(file_path), 
                encoding=self._scale['encoding'], 
                shape=self._get_chunk_shape(c),
                dtype=self.info['data_type'])
            return_volume[self._slices_from_chunk(c,offset)] = content
        return return_volume[sub_slices]

    def __setitem__(self, slices, input_volume):
        offset =  self._get_offsets(slices)
        for c in self._iter_chunks(slices):
            content = chunks.encode(
                input_volume[self._slices_from_chunk(c, offset)], 
                self._scale['encoding'])
            self._storage.put_file(
                file_path=self._chunk_to_file_path(c),
                content=content)

    def _get_offsets(self, slices):
        first_chunk = self._iter_chunks(slices).next()
        return [first_chunk.x_start,
                first_chunk.y_start,
                first_chunk.z_start]

    def _get_chunk_shape(self, chunk):
        return (chunk.x_stop-chunk.x_start, 
                chunk.y_stop-chunk.y_start,
                chunk.z_stop-chunk.z_start,
                self.info['num_channels'])

    def _get_slices_shape(self, slices):
        return (slices[0].stop-slices[0].start, 
                slices[1].stop-slices[1].start,
                slices[2].stop-slices[2].start,
                self.info['num_channels'])

    def _chunk_to_file_path(self, chunk):
        return '{}/{}-{}_{}-{}_{}-{}'.format(
            self._scale['key'], 
            chunk.x_start, chunk.x_stop,
            chunk.y_start, chunk.y_stop,
            chunk.z_start, chunk.z_stop)

    def _slices_from_chunk(self, chunk, offset):
        return (slice(chunk.x_start-offset[0],chunk.x_stop-offset[0]),
                slice(chunk.y_start-offset[1],chunk.y_stop-offset[1]),
                slice(chunk.z_start-offset[2],chunk.z_stop-offset[2]),
                slice(0,sys.maxint)) #equivalent to [:]

    def _iter_chunks(self, slices):
        for x_start, x_stop in self._slice_to_chunks(slices, 0):
            for y_start, y_stop in self._slice_to_chunks(slices, 1):
                for z_start, z_stop in self._slice_to_chunks(slices, 2):
                    yield self.Chunk(x_start, x_stop, 
                                     y_start, y_stop,
                                     z_start, z_stop)

    def _align_slices(self, slices):
        """
        Return new_slices, sub_slices with the property that
        new_slices is grid aligned and A[new_slices][sub_slices]
        is equal to A[slices]
        """
        new_slices=[]
        sub_slices=[]
        for slc_idx in xrange(len(slices)):
            slc = slices[slc_idx]
            voxel_offset = self._scale['voxel_offset'][slc_idx]
            start = slc.start - voxel_offset
            stop = slc.stop - voxel_offset
            chunk_size = self._scale['chunk_sizes'][0][slc_idx]

            #round to nearest grid size
            new_start = start - (start % chunk_size)
            new_stop = stop + ((-stop) % chunk_size)

            new_slices.append(slice(new_start, new_stop))
            sub_slices.append(slice(start % chunk_size, stop - new_start))

        return tuple(new_slices), tuple(sub_slices)

    def _slice_to_chunks(self, slices, slc_idx):
        slc = slices[slc_idx]
        # susbstract the offset
        voxel_offset = self._scale['voxel_offset'][slc_idx]
        start = slc.start - voxel_offset
        stop = slc.stop - voxel_offset
        if stop <= start or start < 0:
            raise ValueError(slc)

        chunk_size = self._scale['chunk_sizes'][0][slc_idx]
        layer_size = self._scale['size'][slc_idx]
        if start % chunk_size:
            raise ValueError("{} is not grid aligned".format(slc.start))

        if stop > layer_size or (stop < layer_size and stop % chunk_size):
            raise ValueError("{} is not grid aligned".format(slc.stop))

        chunks = []
        for chunk_start in xrange(start, stop, chunk_size):
            chunk_stop = min(chunk_start+chunk_size, layer_size)

            #re-add offsets
            chunk_start += voxel_offset
            chunk_stop += voxel_offset
            chunks.append((chunk_start, chunk_stop))
        return chunks

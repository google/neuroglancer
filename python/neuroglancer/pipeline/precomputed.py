from collections import namedtuple
import json
import itertools
import sys

import numpy as np

from neuroglancer import chunks

class EmptyVolumeException(Exception):
    pass

class Precomputed(object):
    Chunk = namedtuple('Chunk',
        ['x_start','x_stop','y_start','y_stop','z_start','z_stop'])

    def __init__(self, storage, scale_idx=0, fill=False):
        """read/write numpy arrays to a layer.

        It usess the storage class to get and write files,
        each one representing a chunk.

        Most of the code in this class handles the problem of
        transforming an slice into the set of files to read/write.
        So a good understanding of the coordinates system is required.

        Slices for __getitem__ and __setitem__ are both 3-dimensional(x,y,z)
        but the chunk retrieves for __getitem__ are 4-dimensional,
        because they also include the channels, even if there is only one.
        Similarly, __setitem__ expects a 4-dimensional array as an input.

        We have no support por advance slicing as numpy has, e.i no negative
        indexing, no support for ommitting the start or the end.
        stride is assumed to be 1. TODO support this

        Now the important stuff that you need to know to understand the math.
        This applies to x,y,z dimensions.
        The distance from 0 to the first pixel is called "voxel_offset", and it
        can be any positive integer.
        After that there is 0 or more chunks all of the same "chunk_size".
        After that there is one more chunk which is of size "chunk_size" or smaller
        but larger than zero.
        the last pixel is at "voxel_offset" + "size".
        The size of the last chunk is equal to "size" % "chunk_size".
        Find a more complete explanation here:
        https://github.com/seung-lab/neuroglancer/wiki/Precomputed-API

        Args:
            storage (Storate): Description
            scale_idx (int, optional): scale index,
                useful to operate on downsample images
            fill (bool, optional): if false, when failing to
                get an underlying chunk it will raise an
                EmptyVolumeException. Otherwise the underlying
                chunk would be assume to containe zeros.
        """
        self._storage = storage
        self._fill = fill
        self._download_info()
        self._scale = self.info['scales'][scale_idx]

        # Don't know how to handle more than one
        assert len(self._scale['chunk_sizes']) == 1

    def _download_info(self):
        self.info = json.loads(self._storage.get_file('info'))

    def __getitem__(self, slices):
        """ It allows for non grid aligned slices
        """
        aligned_slices, crop_slices = self._align_slices(slices)
        return_volume = np.empty(
            shape=self._get_slices_shape(aligned_slices),
            dtype=self.info['data_type'])
        
        offset =  self._get_offsets(aligned_slices)
        for c in self._iter_chunks(aligned_slices):
            file_path = self._chunk_to_file_path(c)
            content =  self._storage.get_file(file_path)
            if not content and not self._fill:
                raise EmptyVolumeException()

            content = chunks.decode(
                self._storage.get_file(file_path), 
                encoding=self._scale['encoding'], 
                shape=self._get_chunk_shape(c),
                dtype=self.info['data_type'])
            return_volume[self._slices_from_chunk(c,offset)] = content
        return return_volume[crop_slices]

    def __setitem__(self, slices, input_volume):
        """
        It purposely doesn't allow for non grid aligned slices.
        That is because the result of two workers writting
        to overlapping chunks would be hard to predict.
        """
        offset =  self._get_offsets(slices)
        for c in self._iter_chunks(slices):
            input_chunk = input_volume[self._slices_from_chunk(c, offset)]
            if input_chunk.shape != self._get_chunk_shape(c):
                raise ValueError("Illegal slicing, {} != {}".format(
                    self._get_slices_shape(slices), input_volume.shape))

            content = chunks.encode(input_chunk, self._scale['encoding'])
            self._storage.put_file(
                file_path=self._chunk_to_file_path(c),
                content=content)
        self._storage.wait()

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

    def _substract_offset(self, slc, offset):
        return slice(slc.start - offset, slc.stop - offset)

    def _add_offset(self, slc, offset):
        return slice(slc.start + offset, slc.stop + offset)

    def _align_slices(self, slices):
        """
        Return aligned_slices, crop_slices with the property that
        new_slices is grid aligned and A[aligned_slices][crop_slices]
        is equal to A[slices]
        """
        crop_slices , aligned_slices = [], []
        for slc_idx in xrange(len(slices)):
            voxel_offset = self._scale['voxel_offset'][slc_idx]
            chunk_size = self._scale['chunk_sizes'][0][slc_idx]
            size = self._scale['size'][slc_idx]
            slc = slices[slc_idx]
            slc = self._substract_offset(slc, voxel_offset)
            start, stop = slc.start , slc.stop

            #round to nearest grid size
            aligned_start = start - (start % chunk_size)
            aligned_stop = min(stop + (-stop % chunk_size), size)
            aligned_slc = slice(aligned_start,aligned_stop)
            aligned_slices.append(self._add_offset(aligned_slc, voxel_offset))

            crop_start = start % chunk_size
            crop_stop = stop - aligned_start
            crop_slices.append(slice(crop_start, crop_stop))

        return tuple(aligned_slices), tuple(crop_slices)

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
            raise ValueError("{} is not grid aligned or larger than the dataset".format(slc.stop))

        chunks = []
        for chunk_start in xrange(start, stop, chunk_size):
            chunk_stop = min(chunk_start+chunk_size, layer_size)

            #re-add offsets
            chunk_start += voxel_offset
            chunk_stop += voxel_offset
            chunks.append((chunk_start, chunk_stop))
        return chunks

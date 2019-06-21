import argparse
import neuroglancer
import numpy as np
from cloudvolume import CloudVolume, Storage
from cloudvolume.lib import Bbox
import json

class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.int64)):
            return int(obj) 
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)

def create_segment_metadata_file(cv_input_path, cv_output_path, output_filename, override_default_size_limit):
    mip = 0
    cv = CloudVolume(cv_input_path, mip)
    max_allowed_size = np.int64(3000000000)
    vol_size = np.prod(cv.volume_size)
    if vol_size > max_allowed_size and not override_default_size_limit:
        raise ValueError(f'Volume size of {vol_size} exceeds maximum of 3 billion voxels')
    volume_bbox = Bbox(cv.voxel_offset, cv.shape[0:3] + cv.voxel_offset)
    data = cv[volume_bbox]
    unique_segids = np.unique(data, return_counts=True)
    del data
    arr = np.array([])
    for x in zip(unique_segids[0], unique_segids[1]):
        if x[0] != 0:
            arr = np.append(arr, {
                "segmentId": str(x[0]),
                "voxelCount": x[1]
            })
    with Storage(cv_output_path) as storage:
        storage.put_file(
            file_path=output_filename,
            content=json.dumps(arr, cls=NumpyEncoder),
            compress=False,
            cache_control='no-cache'
        )

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--segmentation-path',
        required=True, help='CloudVolume path for segmentation')
    ap.add_argument('--output-path', required=False,
        help='CloudVolume filepath to store the output file (default is {segmentation-path}/segment_metadata)')
    ap.add_argument('--output-filename', required=False,
        help='Output filename (default is segment_metadata.json)')
    ap.add_argument('--override-max-allowed-volume-size', action='store_true',
        required=False, help='Override volume voxel size limit of 3 billion')
    args = ap.parse_args()
    if not args.output_path:
        args.output_path = f'{args.segmentation_path}/segment_metadata'
    if not args.output_filename:
        args.output_filename = 'segment_metadata.json'
    create_segment_metadata_file(args.segmentation_path, args.output_path,
        args.output_filename, args.override_max_allowed_volume_size)
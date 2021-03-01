#!/usr/bin/env python

"""Example of displaying interactive image-to-image "inference" results.

shift+mousedown0 triggers the inference result to be computed for the patch
centered around the mouse position, and then displayed in neuroglancer.

In this example, the inference result is actually just a distance transform
computed from the ground truth segmentation, but in actual use the inference
result may be computed using SciPy, Tensorflow, PyTorch, etc.

The cloudvolume library (https://github.com/seung-lab/cloud-volume) is used to
retrieve patches of the ground truth volume.

The zarr library is used to represent the sparse in-memory array containing the
computed inference results that are displayed in neuroglancer.

"""

import argparse
import time

import neuroglancer
import neuroglancer.cli
import cloudvolume
import zarr
import numpy as np
import scipy.ndimage


class InteractiveInference(object):
    def __init__(self):
        viewer = self.viewer = neuroglancer.Viewer()
        viewer.actions.add('inference', self._do_inference)
        self.gt_vol = cloudvolume.CloudVolume(
            'https://storage.googleapis.com/neuroglancer-public-data/flyem_fib-25/ground_truth',
            mip=0,
            bounded=True,
            progress=False,
            provenance={})
        self.dimensions = neuroglancer.CoordinateSpace(
            names=['x', 'y', 'z'],
            units='nm',
            scales=self.gt_vol.resolution,
        )
        self.inf_results = zarr.zeros(
            self.gt_vol.bounds.to_list()[3:], chunks=(64, 64, 64), dtype=np.uint8)
        self.inf_volume = neuroglancer.LocalVolume(
            data=self.inf_results, dimensions=self.dimensions)
        with viewer.config_state.txn() as s:
            s.input_event_bindings.data_view['shift+mousedown0'] = 'inference'

        with viewer.txn() as s:
            s.layers['image'] = neuroglancer.ImageLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
            )
            s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
            )
            s.layers['ground_truth'].visible = False
            s.layers['inference'] = neuroglancer.ImageLayer(
                source=self.inf_volume,
                shader='''
void main() {
  float v = toNormalized(getDataValue(0));
  vec4 rgba = vec4(0,0,0,0);
  if (v != 0.0) {
    rgba = vec4(colormapJet(v), 1.0);
  }
  emitRGBA(rgba);
}
''',
            )

    def _do_inference(self, action_state):
        pos = action_state.mouse_voxel_coordinates
        if pos is None:
            return
        patch_size = np.array((128, ) * 3, np.int64)
        spos = pos - patch_size // 2
        epos = spos + patch_size
        slice_expr = np.s_[int(spos[0]):int(epos[0]),
                           int(spos[1]):int(epos[1]),
                           int(spos[2]):int(epos[2])]
        gt_data = self.gt_vol[slice_expr][..., 0]
        boundary_mask = gt_data == 0
        boundary_mask[:, :, :-1] |= (gt_data[:, :, :-1] != gt_data[:, :, 1:])
        boundary_mask[:, :, 1:] |= (gt_data[:, :, :-1] != gt_data[:, :, 1:])
        boundary_mask[:, :-1, :] |= (gt_data[:, :-1, :] != gt_data[:, 1:, :])
        boundary_mask[:, 1:, :] |= (gt_data[:, :-1, :] != gt_data[:, 1:, :])
        boundary_mask[:-1, :, :] |= (gt_data[:-1, :, :] != gt_data[1:, :, :])
        boundary_mask[1:, :, :] |= (gt_data[:-1, :, :] != gt_data[1:, :, :])
        dist_transform = scipy.ndimage.morphology.distance_transform_edt(~boundary_mask)
        self.inf_results[slice_expr] = 1 + np.cast[np.uint8](
            np.minimum(dist_transform, 5) / 5.0 * 254)
        self.inf_volume.invalidate()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    inf = InteractiveInference()
    print(inf.viewer)

    while True:
        time.sleep(1000)

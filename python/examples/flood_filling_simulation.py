#!/usr/bin/env python

"""Example of display interactive flood-filling "inference" results.

shift+mousedown0 triggers the simulated flood filling to start with an initial
seed at the mouse position.  The computed mask values are displayed as an image,
while the seed points chosen are displayed as point annotations.

keyt causes the simulated flood filling to stop.

In this example, the mask values are actually just computed as a distance
transform of the ground truth segmentation, and the seed points are restricted
to the ground truth segment and assign random priorities.  In actual use, this
same visualization approach can be used to display the actual mask and seed
points computed by a flood filling TensorFlow model.

The cloudvolume library (https://github.com/seung-lab/cloud-volume) is used to
retrieve patches of the ground truth volume.

The zarr library is used to represent the sparse in-memory array containing the
computed inference results that are displayed in neuroglancer.

"""

import random
import time
import threading

import neuroglancer
import cloudvolume
import zarr
import numpy as np
import scipy.ndimage


class InteractiveInference(object):
    def __init__(self):
        viewer = self.viewer = neuroglancer.Viewer()
        self.gt_vol = cloudvolume.CloudVolume(
            'https://storage.googleapis.com/neuroglancer-public-data/flyem_fib-25/ground_truth',
            mip=0,
            bounded=True,
            progress=False,
            provenance={})
        viewer.actions.add('start-fill', self._start_fill_action)
        viewer.actions.add('stop-fill', self._stop_fill_action)
        with viewer.config_state.txn() as s:
            s.input_event_bindings.data_view['shift+mousedown0'] = 'start-fill'
            s.input_event_bindings.data_view['keyt'] = 'stop-fill'

        with viewer.txn() as s:
            s.layers['image'] = neuroglancer.ImageLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
            )
            s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
                source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
            )
            s.layers['ground_truth'].visible = False
            self.flood_fill_event = None

    def _do_flood_fill(self, initial_pos, inf_results, inf_volume, event):
        initial_pos = (int(initial_pos[0]), int(initial_pos[1]), int(initial_pos[2]))

        gt_vol_zarr = zarr.zeros(
            self.gt_vol.bounds.to_list()[3:][::-1], chunks=(64, 64, 64), dtype=np.uint64)

        gt_blocks_seen = set()

        block_size = np.array((64, 64, 64), np.int64)

        def fetch_gt_block(block):
            spos = block * block_size
            epos = spos + block_size
            slice_expr = np.s_[int(spos[0]):int(epos[0]),
                               int(spos[1]):int(epos[1]),
                               int(spos[2]):int(epos[2])]
            rev_slice_expr = np.s_[int(spos[2]):int(epos[2]),
                                   int(spos[1]):int(epos[1]),
                                   int(spos[0]):int(epos[0])]
            gt_data = np.transpose(self.gt_vol[slice_expr][..., 0], (2, 1, 0))
            gt_vol_zarr[rev_slice_expr] = gt_data

        def get_patch(spos, epos):
            spos = np.array(spos)
            epos = np.array(epos)
            sblock = spos // block_size
            eblock = (epos - 1) // block_size
            for blockoff in np.ndindex(tuple(eblock - sblock + 1)):
                block = np.array(blockoff) + sblock
                block_tuple = tuple(block)
                if block_tuple in gt_blocks_seen: continue
                gt_blocks_seen.add(block_tuple)
                fetch_gt_block(block)
            rev_slice_expr = np.s_[int(spos[2]):int(epos[2]),
                                   int(spos[1]):int(epos[1]),
                                   int(spos[0]):int(epos[0])]
            result = gt_vol_zarr[rev_slice_expr]
            return result

        segment_id = self.gt_vol[initial_pos][0]

        patch_size = np.array((33, ) * 3, np.int64)
        lower_bound = patch_size // 2
        upper_bound = np.array(self.gt_vol.bounds.to_list()[3:]) - patch_size + patch_size // 2
        d = 8

        seen = set()
        q = []

        last_invalidate = [time.time()]
        invalidate_interval = 3

        def enqueue(pos):
            if np.any(pos < lower_bound) or np.any(pos >= upper_bound): return
            if pos in seen: return
            seen.add(pos)
            q.append(pos)

        def update_view():
            if event.is_set():
                return
            cur_time = time.time()
            if cur_time < last_invalidate[0] + invalidate_interval:
                return
            last_invalidate[0] = cur_time
            inf_volume.invalidate()
            with self.viewer.txn() as s:
                s.layers['points'].annotations = [
                    neuroglancer.PointAnnotation(id=repr(pos), point=pos) for pos in list(seen)
                ]

        def process_pos(pos):
            spos = pos - patch_size // 2
            epos = spos + patch_size
            rev_slice_expr = np.s_[int(spos[2]):int(epos[2]),
                                   int(spos[1]):int(epos[1]),
                                   int(spos[0]):int(epos[0])]
            gt_data = get_patch(spos, epos)
            mask = gt_data == segment_id
            for offset in ((0, 0, d), (0, 0, -d), (0, d, 0), (0, -d, 0), (d, 0, 0), (-d, 0, 0)):
                if not mask[tuple(patch_size // 2 + offset)[::-1]]: continue
                new_pos = np.array(pos) + np.array(offset)
                enqueue(tuple(new_pos))

            dist_transform = scipy.ndimage.morphology.distance_transform_edt(~mask)
            inf_results[rev_slice_expr] = 1 + np.cast[np.uint8](
                np.minimum(dist_transform, 5) / 5.0 * 254)

            self.viewer.defer_callback(update_view)

        enqueue(initial_pos)

        while len(q) > 0 and not event.is_set():
            i = random.randint(0, len(q) - 1)
            pos = q[i]
            q[i] = q[-1]
            del q[-1]
            process_pos(pos)
        self.viewer.defer_callback(update_view)

    def _stop_flood_fill(self):
        if self.flood_fill_event is not None:
            self.flood_fill_event.set()
            self.flood_fill_event = None

    def _start_flood_fill(self, pos):
        self._stop_flood_fill()
        inf_results = zarr.zeros(
            self.gt_vol.bounds.to_list()[3:][::-1], chunks=(64, 64, 64), dtype=np.uint8)
        inf_volume = neuroglancer.LocalVolume(
            data=inf_results, voxel_size=list(self.gt_vol.resolution))

        with self.viewer.txn() as s:
            s.layers['points'] = neuroglancer.AnnotationLayer()
            s.layers['inference'] = neuroglancer.ImageLayer(
                source=inf_volume,
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
        self.flood_fill_event = threading.Event()
        t = threading.Thread(
            target=self._do_flood_fill,
            kwargs=dict(
                initial_pos=pos,
                inf_results=inf_results,
                inf_volume=inf_volume,
                event=self.flood_fill_event,
            ))
        t.daemon = True
        t.start()

    def _start_fill_action(self, action_state):
        pos = action_state.mouse_voxel_coordinates
        if pos is None:
            return
        self._start_flood_fill(pos)

    def _stop_fill_action(self, action_state):
        self._stop_flood_fill()


if __name__ == '__main__':
    inf = InteractiveInference()
    print(inf.viewer)

    while True:
        time.sleep(1000)

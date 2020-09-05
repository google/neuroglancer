from __future__ import print_function

import argparse
import numpy as np

import neuroglancer

ap = argparse.ArgumentParser()
ap.add_argument(
    '-a',
    '--bind-address',
    help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
    'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.')
ap.add_argument(
    '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')
args = ap.parse_args()
if args.bind_address:
    neuroglancer.set_server_bind_address(args.bind_address)
if args.static_content_url:
    neuroglancer.set_static_content_source(url=args.static_content_url)

a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
ix, iy, iz = np.meshgrid(* [np.linspace(0, 1, n) for n in a.shape[1:]], indexing='ij')
a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255

b = np.cast[np.uint32](np.floor(np.sqrt((ix - 0.5)**2 + (iy - 0.5)**2 + (iz - 0.5)**2) * 10))
b = np.pad(b, 1, 'constant')

viewer = neuroglancer.Viewer()
dimensions = neuroglancer.CoordinateSpace(
    names=['x', 'y', 'z'],
    units='nm',
    scales=[10, 10, 10])
with viewer.txn() as s:
    s.dimensions = dimensions
    s.layers.append(
        name='a',
        layer=neuroglancer.LocalVolume(
            data=a,
            dimensions=neuroglancer.CoordinateSpace(
                names=['c^', 'x', 'y', 'z'],
                units=['', 'nm','nm','nm'],
                scales=[1, 10, 10, 10]),
            voxel_offset=(0, 20, 30, 15),
        ),
        shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""")
    s.layers.append(
        name='b', layer=neuroglancer.LocalVolume(
            data=b,
            dimensions=dimensions,
        ))

def _make_viewport_adjust_command(adjustments):
    def handler(s):
        with viewer.txn() as s:
            for i, amount in adjustments:
                s.partial_viewport[i] += amount
            s.partial_viewport[:2] = np.clip(s.partial_viewport[:2], 0, 0.9)
            s.partial_viewport[2:] = np.clip(s.partial_viewport[2:], 0.1,
                                             1 - s.partial_viewport[:2])
            partial_viewport = np.array(s.partial_viewport)

        with viewer.config_state.txn() as s:
            s.viewer_size = [256, 256]
            s.status_messages['note'] = 'Viewport: %r' % (partial_viewport, )

    return handler
viewer.actions.add('viewport-translate-left', _make_viewport_adjust_command([(0, -0.1)]))
viewer.actions.add('viewport-translate-right', _make_viewport_adjust_command([(0, 0.1)]))
viewer.actions.add('viewport-translate-up', _make_viewport_adjust_command([(1, -0.1)]))
viewer.actions.add('viewport-translate-down', _make_viewport_adjust_command([(1, 0.1)]))
viewer.actions.add('viewport-shrink-width', _make_viewport_adjust_command([(2, -0.1)]))
viewer.actions.add('viewport-enlarge-width', _make_viewport_adjust_command([(2, 0.1)]))
viewer.actions.add('viewport-shrink-height', _make_viewport_adjust_command([(3, -0.1)]))
viewer.actions.add('viewport-enlarge-height', _make_viewport_adjust_command([(3, 0.1)]))

with viewer.config_state.txn() as s:
    s.input_event_bindings.viewer['keyh'] = 'viewport-translate-left'
    s.input_event_bindings.viewer['keyl'] = 'viewport-translate-right'
    s.input_event_bindings.viewer['keyj'] = 'viewport-translate-down'
    s.input_event_bindings.viewer['keyk'] = 'viewport-translate-up'
    s.input_event_bindings.viewer['shift+keyu'] = 'viewport-shrink-height'
    s.input_event_bindings.viewer['shift+keyi'] = 'viewport-enlarge-height'
    s.input_event_bindings.viewer['shift+keyy'] = 'viewport-shrink-width'
    s.input_event_bindings.viewer['shift+keyo'] = 'viewport-enlarge-width'

print(viewer)

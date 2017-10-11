from __future__ import print_function

import numpy as np

import neuroglancer

a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
ix, iy, iz = np.meshgrid(*[np.linspace(0, 1, n) for n in a.shape[1:]], indexing='ij')
a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255

b = np.cast[np.uint32](np.floor(np.sqrt((ix - 0.5)**2 + (iy - 0.5)**2 + (iz - 0.5)**2) * 10))
b = np.pad(b, 1, 'constant')

viewer = neuroglancer.Viewer()
with viewer.txn() as s:
  s.voxel_size = [10, 10, 10]
  s.append_layer(name='a',
                 layer=neuroglancer.LocalVolume(
                     data=a,
                     # offset is in nm, not voxels
                     offset=(200, 300, 150),
                     voxel_size=s.voxel_size,
                 ),
                 shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""")
  s.append_layer(name='b',
                 layer=neuroglancer.LocalVolume(
                     data=b,
                     voxel_size=s.voxel_size,
                 ))
print(viewer)

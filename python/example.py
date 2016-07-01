from __future__ import print_function

import neuroglancer
import numpy as np

a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
ix, iy, iz = np.meshgrid(*[np.linspace(0, 1, n) for n in a.shape[1:]], indexing='ij')
a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255

b = np.cast[np.uint32](np.floor(np.sqrt((ix - 0.5)**2 + (iy - 0.5)**2 + (iz - 0.5)**2) * 10))

# Obtain the bundled Neuroglancer client code (HTML, CSS, and JavaScript) from
# the demo server, so that this example works even if
#
#   python setup.py bundle_client
#
# has not been run.
neuroglancer.set_static_content_source(url='https://neuroglancer-demo.appspot.com')

viewer = neuroglancer.Viewer()
viewer.add(a,
           name='a',
           offset=(20, 30, 50),
           shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""")
viewer.add(b, name='b')
print(viewer)

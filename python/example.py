from __future__ import print_function

import neuroglancer
import numpy as np

ix, iy, iz = np.meshgrid(*[np.linspace(0, 1, n) for n in [100, 100, 100]])
a = np.zeros((3, 100,100,100), dtype=np.float32)
a[0,:,:,:] = np.cast[np.float32](np.abs(np.sin(4 * (ix + iy))))
a[1,:,:,:] = np.cast[np.float32](np.abs(np.sin(4 * (iy + iz))))
a[2,:,:,:] = np.cast[np.float32](np.abs(np.sin(4 * (ix + iz))))

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

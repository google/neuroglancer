import scipy.ndimage.measurements as measurements
from misc_utils import *
import os.path
import numpy as np

raw_labels=h5read(os.path.expanduser("~/mydatasets/golden/raw.h5"), force=True)
centroids = np.array(measurements.center_of_mass(np.ones_like(raw_labels), raw_labels, xrange(np.max(raw_labels)+1)))
h5write(os.path.expanduser("~/mydatasets/golden/raw_centroids.h5"), centroids)


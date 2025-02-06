.. _nifti-datasource:

NIfTI
=====

The NIfTI :ref:`data format driver<data-formats>` supports `NIfTI
<https://www.nitrc.org/projects/nifti>`__ v1 and v2.

URL syntax
----------

- :file:`{KVSTORE-URL.nii}|nifti:`

Examples
--------

- `https://s3.amazonaws.com/openneuro.org/ds005891/sub-03/ses-01/anat/sub-03_ses-01_T1w.nii.gz|gzip:|nifti: <https://neuroglancer-demo.appspot.com/#!%7B%22dimensions%22:%7B%22x%22:%5B0.001%2C%22m%22%5D%2C%22y%22:%5B0.001%2C%22m%22%5D%2C%22z%22:%5B0.001%2C%22m%22%5D%7D%2C%22position%22:%5B5.488064765930176%2C-18.51105499267578%2C13.5%5D%2C%22crossSectionScale%22:0.30119421191220225%2C%22projectionOrientation%22:%5B-0.44944286346435547%2C-0.6089291572570801%2C0.5014128088951111%2C0.41927507519721985%5D%2C%22projectionScale%22:512.0000000000002%2C%22projectionDepth%22:-50.00000000000007%2C%22layers%22:%5B%7B%22type%22:%22image%22%2C%22source%22:%22https://s3.amazonaws.com/openneuro.org/ds005891/sub-03/ses-01/anat/sub-03_ses-01_T1w.nii.gz%7Cgzip:%7Cnifti:%22%2C%22tab%22:%22rendering%22%2C%22shaderControls%22:%7B%22normalized%22:%7B%22range%22:%5B0%2C543%5D%2C%22window%22:%5B-137%2C680%5D%7D%7D%2C%22volumeRendering%22:%22max%22%2C%22volumeRenderingDepthSamples%22:512%2C%22name%22:%22sub-03_ses-01_T1w.%22%7D%5D%2C%22showSlices%22:false%2C%22selectedLayer%22:%7B%22visible%22:true%2C%22layer%22:%22sub-03_ses-01_T1w.nii.gz?versionId=lXa.V7Cm8qXV9G76IiFPHD8U6v5sz4Ve%22%7D%2C%22layout%22:%224panel%22%7D>`__

  `ProactionLab (2025). RSfMRI. OpenNeuro. [Dataset] <https://doi.org/10.18112/openneuro.ds005891.v1.0.0>`__

Auto detection
--------------

NIfTI files are detected automatically based on the signature at the start of
the file.

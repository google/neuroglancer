import numpy as np

from neuroglancer import downsample_scales


def test_plane_scales_xy():
  scales = downsample_scales.compute_plane_downsampling_scales( 
    (2048, 2048, 512), max_downsampled_size=128
  )

  assert len(scales) == 5
  assert scales[0] == (1,1,1)
  assert scales[1] == (2,2,1)
  assert scales[2] == (4,4,1)
  assert scales[3] == (8,8,1)
  assert scales[4] == (16,16,1)

  scales = downsample_scales.compute_plane_downsampling_scales( 
    (357, 2048, 512), max_downsampled_size=128
  )

  assert len(scales) == 2
  assert scales[0] == (1,1,1)
  assert scales[1] == (2,2,1)

  scales = downsample_scales.compute_plane_downsampling_scales( 
    (0, 2048, 512), max_downsampled_size=128
  )

  assert len(scales) == 1
  assert scales[0] == (1,1,1)


def test_plane_scales_yz():
  scales = downsample_scales.compute_plane_downsampling_scales( 
    (512, 2048, 2048), max_downsampled_size=128, preserve_axis='x'
  )

  assert len(scales) == 5
  assert scales[0] == (1,1,1)
  assert scales[1] == (1,2,2)
  assert scales[2] == (1,4,4)
  assert scales[3] == (1,8,8)
  assert scales[4] == (1,16,16)


  scales = downsample_scales.compute_plane_downsampling_scales( 
    (64, 2048, 2048), max_downsampled_size=128, preserve_axis='x'
  )

  assert len(scales) == 5
  assert scales[0] == (1,1,1)
  assert scales[1] == (1,2,2)
  assert scales[2] == (1,4,4)
  assert scales[3] == (1,8,8)
  assert scales[4] == (1,16,16)



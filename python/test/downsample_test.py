import numpy as np

from neuroglancer import downsample

image1x1x1 = np.array([[[[0]]]])

image2x2x2 = np.array([ 
  [
    [ [1], [1] ],
    [ [2], [2] ],
  ], 
  [
    [ [1], [0 ] ],
    [ [0], [30] ],
  ] 
])

image3x3x3 = np.array([ 
  [#z 0  1  2   
    [ [1], [1], [1] ], # y=0
    [ [1], [1], [1] ], # y=1      # x=0
    [ [1], [1], [1] ], # y=2
  ], 
  [
    [ [2], [2], [2] ], # y=0 
    [ [2], [2], [2] ], # y=1      # x=1
    [ [2], [2], [2] ], # y=2
  ],
  [
    [ [3], [3], [3] ], # y=0
    [ [3], [3], [3] ], # y=1      # x=2
    [ [3], [3], [3] ], # y=2
  ],
])

def test_even_odd():
  evenimg = downsample.odd_to_even(image2x2x2)
  assert np.array_equal(evenimg, image2x2x2)

  oddimg = downsample.odd_to_even(image1x1x1).astype(int)
  
  ans1x1x1 = np.array([
    [
      [ [0] ],
      [ [0] ], 
    ],
    [
      [ [0] ],
      [ [0] ] 
    ]
  ])

  assert np.array_equal(oddimg, ans1x1x1)

  oddimg = downsample.odd_to_even(image3x3x3)

  ans3x3x3 = np.array([
    [
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
    ],
    [
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
      [ [1], [1], [1] ], 
    ],
    [
      [ [2], [2], [2] ],
      [ [2], [2], [2] ],
      [ [2], [2], [2] ],
      [ [2], [2], [2] ],
    ],
    [
      [ [3], [3], [3] ],
      [ [3], [3], [3] ],
      [ [3], [3], [3] ],
      [ [3], [3], [3] ],
    ]
  ])

  assert np.array_equal(oddimg, ans3x3x3)

def test_downsample_segmentation_4x_z():
  case1 = np.array([ [ 0, 1 ], [ 2, 3 ] ]).reshape((2,2,1,1)) # all different
  case2 = np.array([ [ 0, 0 ], [ 2, 3 ] ]).reshape((2,2,1,1)) # two are same
  case3 = np.array([ [ 1, 1 ], [ 2, 2 ] ]).reshape((2,2,1,1)) # two groups are same
  case4 = np.array([ [ 1, 2 ], [ 2, 2 ] ]).reshape((2,2,1,1)) # 3 are the same
  case5 = np.array([ [ 5, 5 ], [ 5, 5 ] ]).reshape((2,2,1,1)) # all are the same

  is_255_handled = np.array([ [ 255, 255 ], [ 1, 2 ] ], dtype=np.uint8).reshape((2,2,1,1))

  test = lambda case: downsample.downsample_segmentation_2D_4x(case)[0][0][0][0]

  assert test(case1) == 3 # d
  assert test(case2) == 0 # a==b
  assert test(case3) == 1 # a==b
  assert test(case4) == 2 # b==c
  assert test(case5) == 5 # a==b

  assert test(is_255_handled) == 255 

  assert downsample.downsample_segmentation_2D_4x(case1).dtype == case1.dtype

  #  0 0 1 3 
  #  1 1 6 3  => 1 3

  case_odd = np.array([ 
    [
      [ [1] ], 
      [ [0] ] 
    ],
    [
      [ [1] ],
      [ [6] ],
    ],
    [
      [ [3] ],
      [ [3] ],
    ],
  ]) # all are the same

  downsamplefn = downsample.method('segmentation')

  result = downsamplefn(case_odd, (2,2,1))

  assert np.array_equal(result, np.array([
    [
      [ [1] ]
    ],
    [
      [ [3] ]
    ]
  ]))

  data = np.ones(shape=(1024, 511, 62, 1), dtype=int)
  result = downsamplefn(data, (2,2,1))
  assert result.shape == (512, 256, 62, 1)

def test_downsample_segmentation_4x_x():
  case1 = np.array([ [ 0, 1 ], [ 2, 3 ] ]).reshape((1,2,2,1)) # all different
  case2 = np.array([ [ 0, 0 ], [ 2, 3 ] ]).reshape((1,2,2,1)) # two are same
  case3 = np.array([ [ 1, 1 ], [ 2, 2 ] ]).reshape((1,2,2,1)) # two groups are same
  case4 = np.array([ [ 1, 2 ], [ 2, 2 ] ]).reshape((1,2,2,1)) # 3 are the same
  case5 = np.array([ [ 5, 5 ], [ 5, 5 ] ]).reshape((1,2,2,1)) # all are the same

  is_255_handled = np.array([ [ 255, 255 ], [ 1, 2 ] ], dtype=np.uint8).reshape((1,2,2,1))

  test = lambda case: downsample.downsample_segmentation(case, (1,2,2))[0][0][0][0]

  assert test(case1) == 3 # d
  assert test(case2) == 0 # a==b
  assert test(case3) == 1 # a==b
  assert test(case4) == 2 # b==c
  assert test(case5) == 5 # a==b

  assert test(is_255_handled) == 255 

  assert downsample.downsample_segmentation(case1, (1,2,2)).dtype == case1.dtype

  #  0 0 1 3 
  #  1 1 6 3  => 1 3

  case_odd = np.array([ 
    [
      [ [1], [0] ], 
      [ [1], [6] ],
      [ [3], [3] ]
    ]
  ]) # all are the same

  downsamplefn = downsample.method('segmentation')

  result = downsamplefn(case_odd, (1,2,2))

  assert np.array_equal(result, np.array([
    [
      [ [1] ],
      [ [3] ]
    ]
  ]))

  data = np.ones(shape=(1024, 62, 511, 1), dtype=int)
  result = downsamplefn(data, (1,2,2))
  assert result.shape == (1024, 31, 256, 1)

  result = downsamplefn(result, (1,2,2))
  assert result.shape == (1024, 16, 128, 1)



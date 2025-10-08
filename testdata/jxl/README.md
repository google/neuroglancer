JPEG XL Test Fixtures
======================

This directory holds tiny JPEG XL images used by automated tests.

Generation
----------
Install the JPEG XL reference encoder (macOS example):

  brew install jpeg-xl

Then run:

  npx ts-node build_tools/generate_jxl_fixtures.ts

This creates (by default):
  sample_gray_128.jxl (1x1 grayscale pixel value 128)
  sample_gray_200.jxl (1x1 grayscale pixel value 200)

The tests will decode both at 8-bit and 16-bit depths and verify integrity
and scaling (16-bit value ≈ 8bit * 257).

If fixtures are missing, the related test will skip gracefully.

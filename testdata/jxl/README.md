JPEG XL Test Fixtures
======================

This directory holds tiny JPEG XL images used by automated tests.

Generation
----------
Install the JPEG XL reference encoder (macOS example):

  brew install jpeg-xl

Then run:

  npx ts-node build_tools/generate_jxl_fixtures.ts

This creates:
  gray_u8_128.jxl / gray_u16_40000.jxl / gray_f32_0_25.jxl
    1x1 single-pixel samples for the uint8/uint16/float32 decode paths.
  gray_u8_4x4.jxl
    4x4 grayscale gradient, encoded losslessly (cjxl -d 0). Exercises the
    reshape -> jpegxl codec chain over real spatial data.
  rgb_u8_2x2.jxl
    2x2 three-channel image, encoded losslessly. Exercises channel derivation
    ([h,w,c]) and exact-value color fidelity (no color-space conversion).

The metadata in fixtures.json records the expected decoded values (`values`
for the lossless multi-sample fixtures). If fixtures are missing, the related
test skips gracefully.

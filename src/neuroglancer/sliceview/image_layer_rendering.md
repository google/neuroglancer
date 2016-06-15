# Image Layer Rendering

The rendering of image layers is fully customizable by specifying GLSL fragment
shader code for computing an RGBA output value for each pixel of the viewport
based on the the single- or multi-channel values associated with the
corresponding voxel.

The fragment shader code can be entered interactively from the dropdown menu for an image layer, or programmatically by specifying a `'shader'` property of the JSON specification of the image layer.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 1.0, specified at <https://www.khronos.org/files/opengles_shading_language.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl/webgl-reference-card-1_0.pdf>.

## API

### Retrieving voxel channel value

The raw value for a given channel is obtained by calling the `getDataValue` function:

```glsl
uint8_t getDataValue(int channelIndex = 0);
uint16_t getDataValue(int channelIndex = 0);
uint32_t getDataValue(int channelIndex = 0);
uint64_t getDataValue(int channelIndex = 0);
float getDataValue(int channelIndex = 0);
```
If no `channelIndex` is specified, the value for the first channel is returned.  (The default value of 0 is shown in the above declarations for exposition only.  As GLSL does not support default values for function parameters, the default value is actually implemented as a separate function overload.)  The return type depends on the data type of the volume.  Note that only `float` is a builtin GLSL type.  The remaining types are defined as simple structs in order to avoid ambiguity regarding the nature of the value:
```glsl
struct uint8_t {
  float value;
};
struct uint16_t {
  vec2 value;
};
struct uint32_t {
  vec4 value;
};
struct uint64_t {
  vec4 low, high;
};
```
For all of these struct types, the contained float values each specify a single byte as a normalized value in [0, 1].  To obtain the raw byte value, you must multiply by 255.

To obtain the raw value as a float, call the `toRaw` function:
```glsl
float toRaw(float x) { return x; }
float toRaw(uint8_t x) { return x.value * 255.0; }
float toRaw(uint16_t x) { return x.value.x * 255.0 + x.value.y * 65280.0; }
```

To obtain a normalized value that maps the full range of integer types to [0,1], call the `toNormalized` function:
```glsl
float toNormalized(float x) { return x; }
float toNormalized(uint8_t x) { return x.value; }
float toNormalized(uint16_t x) { return toRaw(x) / 65535.0; }
```

### Emitting pixel values

To emit a normalized grayscale value in the range [0,1], call:
```glsl
void emitGrayscale(float x);
```

To emit an RGB color value (each component in the range [0,1]), call:
```glsl
void emitRGB(vec3 rgb);
```

To emit an RGBA color value (each component in the range [0,1]), call:
```glsl
void emitRGBA(vec4 rgba);
```
Note that the specified alpha value is multiplied by the opacity value for the layer.

To emit a transparent pixel, call:
```glsl
void emitTransparent();
```

### Color maps

You can map values in the range [0,1] to an RGB color using one of the color maps defined in
[colormaps.glsl](../webgl/colormaps.glsl).

### Examples

The default shader, that displays the first channel as a grayscale intensity:
```glsl
void main () {
  emitGrayscale(toNormalized(getDataValue()));
}
```

Outputting a 3-channel volume as RGB:
```glsl
void main () {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
```

Outputting a single-channel volume as a solid red mask with varying alpha (e.g. to overlay a probability map over raw image data):
```glsl
void main () {
  emitRGBA(vec4(1, 0, 0, toNormalized(getDataValue())));
}
```

Outputting a single-channel volume using the Jet colormap:
```glsl
void main () {
  emitRGB(colormapJet(toNormalized(getDataValue())));
}
```

Thresholding a single-channel volume:
```glsl
void main () {
  emitGrayscale(step(0.5, toNormalized(getDataValue())));
}
```

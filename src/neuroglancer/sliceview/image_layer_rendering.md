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
  highp uint value;
};
struct uint16_t {
  highp uint value;
};
struct uint32_t {
  highp uint value;
};
struct uint64_t {
  highp uvec2 value;
};
```
For all of these struct types, the contained float values each specify a single byte as a normalized value in [0, 1].  To obtain the raw byte value, you must multiply by 255.

To obtain the raw value as a float, call the `toRaw` function:
```glsl
float toRaw(float x) { return x; }
highp uint toRaw(uint8_t x) { return x.value; }
highp uint toRaw(uint16_t x) { return x.value; }
highp uint toRaw(uint32_t x) { return x.value; }
```

To obtain a normalized value that maps the full range of integer types to [0,1], call the `toNormalized` function:
```glsl
highp float toNormalized(float x) { return x; }
highp float toNormalized(uint8_t x) { return float(x.value) / 255.0; }
highp float toNormalized(uint16_t x) { return float(x.value) / 65535.0; }
highp float toNormalized(uint32_t x) { return float(x.value) / 4294967295.0; }
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

### Avoiding artifacts due to lossy compression

If a discontinuous color mapping is applied to a volume that is stored or retrieved using lossy compression (e.g. JPEG), compression artifacts may be visible.  Lossy compression can be disabled for individual data sources as follows:

| Data source | Behavior |
| -------- | ------- |
| `boss` | JPEG compression is used by default for image volumes.  For 16 bit images, append a `?window=INT,INT` to request scaled images in 8 bit space. |
| `brainmaps` | JPEG compression is used by default for single-channel uint8 volumes.  To override this, append a `?encoding=raw` query string parameter to the data source URL. |

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

Thresholding a single-channel volume (see note above about avoiding artifacts due to lossy compression):
```glsl
void main () {
  emitGrayscale(step(0.5, toNormalized(getDataValue())));
}
```

Mapping particular values to specific colors (see note above about avoiding artifacts due to lossy compression):
```glsl
void main() {
  float value = toRaw(getDataValue(0));
  vec3 color = vec3(0, 0, 0);
  if (value == 2.0) color = vec3(1, 0, 0);
  if (value == 3.0) color = vec3(0, 1, 0);
  if (value == 4.0) color = vec3(0, 0, 1);
  emitRGB(color);
}
```

# Image Layer Rendering

The rendering of image layers is fully customizable by specifying GLSL fragment
shader code for computing an RGBA output value for each pixel of the viewport
based on the the single- or multi-channel values associated with the
corresponding voxel.

The fragment shader code can be entered interactively from the side panel for an image layer, or
programmatically by specifying a `'shader'` property of the JSON specification of the image layer.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 3.0, specified at <https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl20-reference-guide.pdf>.

## UI Controls

Rendering may depend on values specified by custom UI controls, specified by special `#uicontrol`
directives supported by Neuroglancer as an extension to GLSL.

For example:

```glsl
#uicontrol int channel slider(min=0, max=4)
#uicontrol vec3 color color(default="red")
#uicontrol float brightness slider(min=-1, max=1)
#uicontrol float contrast slider(min=-3, max=3, step=0.01)
void main() {
  emitRGB(color *
          (toNormalized(getDataValue(channel)) + brightness) *
          exp(contrast));
}
```

The directive syntax is:

``` glsl
#uicontrol <type> <name>
#uicontrol <type> <name>(<parameter>=<value>, ...)
#uicontrol <type> <name> <control>
#uicontrol <type> <name> <control>(<parameter>=<value>, ...)
```

which has the effect of defining a variable `<name>` of GLSL type `<type>` whose value is set by a
UI control of type `<control>`.  The valid parameters and `<type>` values depend on the `<control>`
type.  If no parameters are specified, the parentheses may be omitted.  Depending on the specified
`<type>`, `<control>` may be omitted, as described below.

### `slider` controls

The `slider` control type specifies a slider control over an integer or float range.  Directive
syntax:

```glsl
#uicontrol <type> <name> slider(min=<min>, max=<max>, default=<default>, step=<step>)
```

The `<type>` must be `float`, `int`, or `uint`.  The `min` and `max` parameters are required.  The
`step` parameter is optional; if not specified, defaults to `1` for integer ranges and `(<max> -
<min>) / 100` for float ranges.  The `default` parameter indicates the initial value and is
optional; if not specified, defaults to `<min>` for integer ranges and to `(<min> + <max>)/2` for
float ranges.

### `color` controls

The `color` control type specifies a color picker.  Directive syntax:

```glsl
#uicontrol vec3 <name> color(default="<color>")
```

The `<type>` must be `vec3`, which is set to the RGB `[0, 1]` representation of the color.  The
`default` parameter indicates the initial value as a CSS color string (must be quoted), and defaults
to `"white"` if not specified.

### `checkbox` controls

The `checkbox` control type specifies a checkbox.  Directive syntax:

```glsl
#uicontrol bool <name> checkbox
#uicontrol bool <name> checkbox(default=false)
#uicontrol bool <name> checkbox(default=true)
```

The default is `false` if not specified.  The variable `<name>` is defined at *compile time* as
either `false` or `true` according to the state of the checkbox.

### `invlerp` controls

The `invlerp` control type allows the user to specify an interval of the layer's data type that is
linearly mapped to a `float` in the interval `[0, 1]`.  The name `invlerp` refers to *inverse linear
interpolation*.  To aid the selection of the interval, an empirical cumulative distribution function
(ECDF) of the currently displayed data is plotted as part of the control.  Additionally, if there
are no channel dimensions, a color legend is also displayed.

Directive syntax:

```glsl
#uicontrol invlerp <name>(range=[3, 75], window=[0, 100], channel=[1,2], clamp=false)
```

The following parameters are supported:

- `range`: Optional.  The default interval to be normalized to `[0, 1]`.  Must be specified as an
  array.  May be overridden using the UI control.  If not specified, defaults to the full range of
  the data type for integer data types, and `[0, 1]` for float32.  It is valid to specify an
  inverted interval like `[50, 20]`.  In this case, 50 maps to 0 and 20 maps to 1.

- `window`: Optional.  The default interval over which the ECDF will be shown.  May be overridden
  using the UI control.  If not specified, defaults to the interval specified for `range`.

- `channel`: Optional.  The channel for which to compute the ECDF.  If the rank of the channel
  coordinate space is 1, may be specified as a single number, e.g. `channel=2`.  Otherwise, must be
  specified as an array, e.g. `channel=[2, 3]`.  May be overriden using the UI control.  If not
  specified, defaults to all-zero channel coordinates.

- `clamp`: Optional.  Indicates whether to clamp the result to `[0, 1]`.  Defaults to `true`.  If
  `false`, the result will be outside `[0, 1]` if the input value is outside the configured range.
  Unlike the other parameters, this cannot be adjusted in the UI.

This directive makes the following shader functions available:

```glsl
float <name>(T value);
float <name>() {
  return <name>(getDataValue(channel...));
}
```

where `T` is the data type returned by `getDataValue`.  The one-parameter overload simply computes
the inverse linear interpolation of the specified value within the range specified by the control.
The zero-parameter overload returns the inverse linear interpolation of the data value for
configured channel.

## API

### Retrieving voxel channel value

The raw value for a given channel is obtained by calling the `getDataValue` or `getInterpolated` function:

```glsl
T getDataValue(int channelIndex...);
T getInterpolated(int channelIndex...);
```

The type `T` is `{u,}int{8,16,32}_t`, `uint64_t`, or `float` depending on the data source.  The
`channelIndex...` parameters specifying the coordinates within the channel dimensions, if any.  For
backward compatibility, if there are no channel dimensions, a single unused `channelIndex` argument
may still be specified.

The `getDataValue` function returns the nearest value without interpolation, while the
`getInterpolated` function uses trilinear interpolation.

Note that only `float` is a builtin GLSL type.  The remaining types are defined as simple structs in order to avoid ambiguity regarding the nature of the value:
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

To obtain the raw value as a float, call the `toRaw` function:
```glsl
float toRaw(float x) { return x; }
highp uint toRaw(uint8_t x) { return float(x.value); }
highp uint toRaw(uint16_t x) { return float(x.value); }
highp uint toRaw(uint32_t x) { return float(x.value); }
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

### Volume rendering

The same shader code is used both for cross-section rendering and for the experimental volume
rendering.  Note that while volume rendering remains experimental, it is not guaranteed that future
Neuroglancer versions will be backwards compatible with JSON states that enable volume rendering.
To allow the shader code to detect the rendering mode (and possibly alter its behavior), the
`VOLUME_RENDERING` constant is defined to either `true` or `false`.

```glsl
#define VOLUME_RENDERING false
#define VOLUME_RENDERING true
```

Reasonable volume rendering can be obtained by calling `emitRGBA` with a constant color and
data-dependent alpha.

### Color maps

You can map values in the range [0,1] to an RGB color using one of the color maps defined in
[colormaps.ts](../webgl/colormaps.ts).

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

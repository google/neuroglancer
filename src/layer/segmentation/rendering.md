# Segmentation rendering

Segmentation rendering can be customized using GLSL shader code.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 3.0, specified at <https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl20-reference-guide.pdf>.

## UI Controls

[UI control directives](../sliceview/image_layer_rendering.md#ui-controls) are supported as for segmentation layers.

## API

### Format of user shader

The basic user shader is in the form of:

```glsl
vec3 segmentColor(vec3 color, bool hasProperties) {
  return color;
}
```

Color in this case is the color that would be displayed if you chose not to override it. The return value is the color that will be output aside from some potential post processing such as selected segment highlights.

A vec4 version of segmentColor can also be used if you want to override the opacity.

### Accessing segmentation properties

To retrieve a numerical property named `myNumericalProperty`, use the syntax `prop("myNumericalProperty")`.

To check if a tag named `myTag` is enabled for a segment, use the syntax

```glsl

if (tag("myTag") {
    // do something
}
```

Numerical properties can also be accessed by creating an invlerp uicontrol.

### Examples

```glsl
#uicontrol invlerp property1(window=[1, 10])
vec4 segmentColor(vec4 color, bool hasProperties) {
  if (!hasProperties) {
    return vec4(0.5, 0.5, 0.5, 1.0);
  }
  vec4 newColor = vec4(0.0, 0.0, 0.0, 1.0);
  newColor.rgb = colormapJet(property1());

  if (tag("lot-of-axon")) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }

  newColor.a = 1.0;

  return newColor;
}
```

```glsl
vec4 segmentColor(vec4 color, bool hasProperties) {
  if (!hasProperties) {
    return vec4(0.5, 0.5, 0.5, 1.0);
  }
  if (prop("NAis") > 10u) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  return color;
}
```

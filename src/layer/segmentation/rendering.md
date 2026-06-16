# Segmentation rendering

Segmentation rendering can be customized using GLSL shader code. The shader is
applied after Neuroglancer has determined the base segment color, including
explicit per-segment colors and the default segment color.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 3.0, specified at <https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl20-reference-guide.pdf>.

## UI Controls

[UI control directives](../sliceview/image_layer_rendering.md#ui-controls) are
supported. Segmentation shaders also support segment property controls:

```glsl
#uicontrol property selectedTag(type="tag")
#uicontrol property selectedNumber(type="number")
#uicontrol property selectedString(type="string")
```

The `type` parameter filters the property picker. Valid values are `tag`,
`number`, `numerical`, and `string`. In shader code, a tag property control is a
`bool`; numerical property controls have the GLSL type corresponding to the
selected property data type; string property controls are string values and may
be compared with string literals.

Numerical segment properties can also be used with `invlerp` controls:

```glsl
#uicontrol float intensity invlerp(property="size", range=[0, 100])
```

If `property` is omitted, the control defaults to the first available numerical
segment property and the selected property may be changed from the UI.

## API

### Format of user shader

The basic user shader is in the form of:

```glsl
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  return color;
}
```

- `color` is the color that would be displayed if you chose not to override it.
  It includes the segment color hash, the default segment color, or a stated
  per-segment color.

- `hasProperties` indicates that segment property data was found for the target
  segment. Check this before relying on property values if your shader needs a
  fallback for segments without property rows.

- `isStated` indicates that `color` came from an explicit stated segment color.

A `vec4` version of `segmentColor` can also be used to override opacity. A
negative alpha means that the shader does not override the opacity determined by
the segmentation layer.

```glsl
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  return color;
}
```

### Accessing segmentation properties

To retrieve a numerical or string property named `myProperty`, use the syntax
`prop("myProperty")`.

To check if a tag named `myTag` is enabled for a segment, use the syntax

```glsl
if (tag("myTag")) {
    // do something
}
```

The helper functions require a segment property map. If the named tag or
property does not exist, shader compilation reports an error.

### Examples

```glsl
#uicontrol float property1 invlerp(property="myNumericalProperty", window=[1, 10])
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  if (!hasProperties) {
    return vec4(0.5, 0.5, 0.5, 1.0);
  }
  if (isStated) {
    return color;
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
#uicontrol property redTag(type="tag")
#uicontrol property size(type="number")
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  if (!hasProperties) {
    return vec3(0.5);
  }
  if (redTag) {
    return vec3(1.0, 0.0, 0.0);
  }
  if (size > 50u) {
    return vec3(1.0, 1.0, 0.0);
  }
  return color.rgb;
}
```

```glsl
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  if (!hasProperties) {
    return vec4(0.5, 0.5, 0.5, 1.0);
  }
  if (isStated) {
    return color;
  }
  if (prop("NAis") > 10u) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  return color;
}
```

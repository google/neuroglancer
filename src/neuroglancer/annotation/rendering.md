# Annotation rendering

Annotation rendering can be customized using GLSL shader code.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 3.0, specified at <https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl20-reference-guide.pdf>.

## UI Controls

[UI control directives](../sliceview/image_layer_rendering.md#ui-controls) are supported as for image layers.

## API

### Accessing annotation properties

To retrieve a property named `myProperty`, use the syntax `prop_myProperty()`.

### Common API

```glsl
const bool PROJECTION_VIEW;
```
Set to `true` when rendering a 3-d projection view, set to `false` when rendering a cross section view.

```glsl
discard;
```
Discards the annotation from rendering (the annotation won't be shown).  Use the syntax `discard;`, not `discard();`.

```glsl
void setColor(vec4 color) {
  setPointMarkerColor(color);
  setLineColor(color);
  setEndpointMarkerColor(color);
  setBoundingBoxBorderColor(color);
  setEllipsoidFillColor(vec4(color.rgb, color.a * (PROJECTION_VIEW ? 1.0 : 0.5)));
}
void setColor(vec3 color) {
  setColor(vec4(color, 1.0));
}
```
Sets the point marker fill color, the line color, the line endpoint marker fill color, the bounding
box border color, and the ellipsoid fill color.

```glsl
vec3 defaultColor();
```
Returns the color set through the "Annotations" tab in the UI, or the `"annotationColor"` member of the layer JSON state.  If not accessed in the shader, the corresponding color selector will not be shown in the UI.  This behaves similarly to a custom color UI control.

### Type-specific API

The same shader code applies to all annotation types, but API functions specific to a particular
annotation type have no effect when rendering other annotation types.

#### Point annotations

Point annotations are rendered as circles.

```glsl
 void setPointMarkerSize(float diameterInScreenPixels);
```
Sets the diameter of the circle in screen pixels (defaults to 5 pixels).

```glsl
void setPointMarkerBorderWidth(float widthInScreenPixels);
```
Sets the border width in screen pixels (defaults to 1 pixel).

```glsl
void setPointMarkerColor(vec4 rgba);
void setPointMarkerColor(vec3 rgb);
```
Sets the fill color (defaults to transparent).  May also be set by calling the generic `setColor` function.

```glsl
void setPointMarkerBorderColor(vec4 rgba);
void setPointMarkerBorderColor(vec3 rgb);
```
Sets the border color (defaults to black with alpha 1).

#### Line annotations

Line annotations are rendered as line segments with circles marking the endpoints.

```glsl
void setLineColor(vec4 rgba);
void setLineColor(vec3 rgb);
```
Sets a constant line color (defaults to transparent).  May also be set by calling the generic `setColor` function.

```glsl
void setLineColor(vec4 startColor, vec4 endColor);
void setLineColor(vec3 startColor, vec3 endColor);
```
Sets a linear color gradient for the line.

```glsl
void setLineWidth(float widthInScreenPixels);
```
Sets the line width (defaults to 1).

```glsl
void setEndpointMarkerColor(vec4 rgba);
void setEndpointMarkerColor(vec3 rgb);
```
Sets the same fill color for both endpoint markers (defaults to transparent).  May also be set by calling the generic `setColor` function.

```glsl
void setEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerColor(vec3 startColor, vec3 endColor);
```
Sets separate fill colors for the endpoint markers.

```glsl
void setEndpointMarkerBorderColor(vec4 rgba);
void setEndpointMarkerBorderColor(vec3 rgb);
```
Sets the same border color for both endpoint markers (defaults to black with alpha 1).

```glsl
void setEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerColor(vec3 startColor, vec3 endColor);
```
Sets separate border colors for the endpoint markers.

```glsl
void setEndpointMarkerSize(float diameter);
```
Sets the same diameter (in screen pixels) for both endpoint markers (defaults to 5 pixels).

```glsl
void setEndpointMarkerSize(float startDiameter, float endDiameter);
```
Sets separate diameters for the endpoint markers.

```glsl
void setEndpointMarkerBorderWidth(float width);
```
Sets the same border width (in screen pixels) for both endpoint markers (defaults to 1 pixel).

```glsl
void setEndpointMarkerBorderWidth(float startWidth, float endWidth);
```
Sets separate border widths for the endpoint markers.

#### Bounding box annotations

```glsl
void setBoundingBoxBorderColor(vec4 rgba);
void setBoundingBoxBorderColor(vec3 rgb);
```
Sets the border color (defaults to transparent).  May also be set by calling the generic `setColor` function.

```glsl
void setBoundingBoxBorderWidth(float widthInScreenPixels);
```
Sets the border width in screen pixels.  Defaults to 1 pixel.

```glsl
void setBoundingBoxFillColor(vec4 rgba);
void setBoundingBoxFillColor(vec3 rgb);
```
Sets the fill color (defaults to transparent).  Currently, this only applies to cross-section views.

#### Ellipsoid annotations

```glsl
void setEllipsoidFillColor(vec4 rgba);
void setEllipsoidFillColor(vec3 rgb);
```
Sets the ellipsoid fill color.  May also be set by calling the generic `setColor` function.

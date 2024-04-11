# Volume Rendering

The volume rendering code includes functions and classes for processing volumetric data and rendering the data via ray marching.

## UI layer settings

### Volume rendering mode

The volume rendering is performed via ray marching. This comes in different modes configured via the UI:

1. `OFF`: Volume rendering is disabled. Only slices are shown. This is the default. In the shader, the `VOLUME_RENDERING` flag is set to `false` when this mode is enabled, and `true` otherwise.
2. `ON`: Direct volume rendering via ray marching is enabled.
3. `MAX`: Maximum intensity projection is enabled. This is a special case of direct volume rendering where the maximum value along each ray is used. Picking is also supported for this mode.
4. `MIN`: Minimum intensity projection is enabled. This is a special case of direct volume rendering where the minimum value along each ray is used. Picking is also supported for this mode.

### Number of depth samples and data resolution

The number of depth samples along a ray is configurable via the Resolution (3D) indicator. Each bar in the indicator represents a different resolution of the data that would be loaded if the corresponding number of depth samples are selected. Selecting a bar will change the number of depth samples along each ray to the estimated optimal number for the selected resolution, and load the data for that resolution. The optimal number of depth samples for each data resolution is calculated based on the physical spacing of the data and the current view settings (e.g. bringing the near and far planes closer together would reduce the optimal number of samples).
Note that hovering over a bar in the indicator for a non-loaded resolution will not show the number of chunks that would be loaded. This is because the number of chunks that would be loaded is not known until the resolution is actually selected. The indicator functions as a guide to help select the resolution along with the number of depth samples.

### Gain in volume rendering mode `ON`

For the direct volume rendering mode (`ON`), the Gain (3D) is a multiplier for the opacity of the rendering. The gain is on an exponential scale, where the opacity is modified by `opacity * exp(gain)`. After gain scaling, the opacity is clamped back to the range 0.0 to 1.0 to ensure no black spots in the resulting image due to over or under compositing. The default value is 0.0, which means no change to the opacity.

## Shader code

As volume rendering is an option of an image layer, the expected shader parameters are available (see [Image Layer Rendering](../sliceview/image_layer_rendering.md)). Additionally, the following are available:

### Intensity emission

`MAX` and `MIN` projection modes both use an intensity value to determine the max or min value encountered along rays. If the intensity is not set manually, it defaults to the value of the last `invlerp` that is called in the shader. For example:

```glsl
#uicontrol invlerp normalized_a
#uicontrol invlerp normalized_b

void main() {
  // Here, the intensity is set to the value of normalized_b
  // The last called invlerp, not the first defined
  emitRGBA(vec4(normalized_b(), 0.0, 0.0, normalized_b()));
}
```

The `emitIntensity` function can be used to emit the intensity along a ray and overwrite the defaut heuristic intensity. The intensity must be a float between 0 and 1. Anything outside of this range will be clamped. In `MAX` mode, any pixel with a resulting intensity of 0 will be transparent. In `MIN` mode, any pixel with a resulting intensity of 1 will be transparent

```glsl
void emitIntensity(float intensity);
```

For example:

```glsl
#uicontrol invlerp channel_a(clamp=true)
#uicontrol invlerp channel_b(clamp=true)

void main() {
  //Multiply by 0.5 to get the average intensity and stay in the 0-1 range
  emitRGBA(vec4(channel_a() + channel_b(), 0.0, 0.0, 0.55));
  emitIntensity(0.5 * (channel_a() + channel_b()));
}
```

### Volume rendering mode switching

In some cases, the shader code may need to be aware of the volume rendering mode. This can be done via the `VOLUME_RENDERING` flag. For example:

```glsl
if (VOLUME_RENDERING) {
  // Volume rendering code
} else {
  // Slice rendering code
}
```

## Implementation details

### Code structure

The main modules in this folder are:

1. `base.ts` - establishes how each visible chunk should be processed, and establishes the conversion between physical spacing and view spacing. The conversion between physical spacing and view spacing is used to determine the optimal number of depth samples along each ray for each resolution of the dataset.
2. `backend.ts` - extends the original chunk manager with a volume-rendering-specific chunk manager to establish chunk priority.
3. `volume_render_layer.ts` - links up to UI parameters from the `ImageUserLayer`, binds together callbacks and chunk management, etc. The drawing operation happens here. For each chunk that is visible, all of the shader parameters get passed to the shader (e.g. the model view projection matrix), and then each chunk that is in GPU memory is processed separately and drawn. The state is considered ready if no chunks that are in GPU memory have not yet been drawn. The vertex shader and the fragment shader are defined in this file. Additionally, the user defined fragment shader is injected into the fragment shader here. The vertex and fragment shaders are then compiled and linked together to form the final shader program:

   - The vertex shader essentially passes normalised screen coordinates for each chunk along with the inverse matrix of the model view projection matrix to get back from screen space to model space.
   - The fragment shader uses this information to determine the start and end point of each ray based on the screen position given by the vertex shader. The fragment shader then establishes how color is accumulated along the rays. The ray start and end points are set up such that the rays all lie within the view-clipping bounds and volume bounds. Finally, the rays are marched through that small clipping box, providing the `curChunkPosition` at each step and also allowing access to the scalar voxel value via `getDataValue()` for the nearest voxel, or `getInterpolatedDataValue()` for a weighted contribution from the nearest eight voxels. The value return will be typed, so use `toRaw` or `toNormalized` to convert to a float (high precision).

### Sampling ratio and opacity correction

To avoid overcompositing when the number of depth samples change, opacity correction is performed. The first step of this involves calculating the sampling ratio, which is the ratio of the chosen number of depth samples to the optimal number of depth samples. The optimal number of depth samples is calculated based on the physical spacing of the data and the view spacing. The sampling ratio is then used to correct the opacity of the color at each step along the ray.

For example, if the optimal number of depth samples for the given data resolution is 250, but we the user selects 375 depth samples, then the sampling ratio would be 2/3 - indicating that we are oversampling. For a voxel with opacity 0.5, the opacity correction would be 0.5 \* (2 / 3) = 0.33. This means that the voxel would contribute less to the final color than it would if the sampling ratio was 1.

### Samples accumulated per chunk

The number of depth samples accumulated along a ray in each chunk is computed in the background based on:

1. The intersection of the ray with the bounding box of the 3D data chunk.
2. If the near and far clipping planes intersect the bounding box of the 3D data chunk.
3. The total user requested depth samples along a ray that travels from the near to far plane.

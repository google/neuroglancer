# Screen-Space Ambient Occlusion (SSAO)

SSAO approximates shadows on 3D mesh surfaces by darkening crevices and concavities
where ambient light would be occluded. It adds depth cues that help us perceive
shapes, and it makes the display more appealing. SSAO is an efficient
post-processing effect applied to the perspective view after opaque geometry is
drawn.

## Overview

This implementation uses the ground truth ambient occlusion (GTAO) algorithm
presented by Jimenez et al. at SIGGRAPH 2016
(https://www.activision.com/cdn/research/PracticalRealtimeStrategiesTRfinal.pdf).

The algorithm does the following for each pixel:

1. Reconstruct the view-space position from the depth buffer.
2. Read the view-space normal from the normal buffer.
3. March in 4 view-space slices (`NUM_DIRECTIONS`) × 8 steps (`NUM_STEPS`) on
   both sides of the pixel to find the positive and negative horizon angles.
4. Project the surface normal into each slice and analytically integrate the
   visible arc between its horizons. If the number of slices and steps were increased
   then the integral would converge on the ground truth value.

Then the raw ambient occlusion is bilaterally blurred (view-space-depth-aware,
5-tap kernel, two passes) and composited with the color buffer using
`color.rgb * pow(ao, intensity)`.

The GTAO pass also accumulates, from the same samples, a simpler concavity-driven
occlusion term, as in the horizon-based ambient occlusion (HBAO) algorithm. (The cost is a
modest `dot` and `max` per sample and no additional texture fetches.) The horizon-based
term darkens pits by proximity of occluders rather than by camera-relative orientation,
and can give a stronger depth cue for surface morphology. A `uDepthCue` parameter (`0`–`1`)
blends the two: `0` is the ground-truth GTAO result, and higher values shift toward the HBAO
result.

## Differences from Jimenez et al. (2016)

The shader computes two terms from one set of depth samples: a GTAO term, by the
paper's horizon search and analytic arc integration, and the HBAO term described
above. The `uDepthCue` parameter blends them. The implementation differs from
the paper as follows:

- It samples 4 slices (`NUM_DIRECTIONS`) of 8 steps (`NUM_STEPS`) per side, with
  per-pixel hash noise on the slice angle and step offset. Its only denoising
  is the bilateral blur; the paper also uses spatial and temporal filtering.
- It sets the radius as a fraction of viewport height, not as a world-space
  distance, so the effect has the same size on screen at every zoom.
- For the GTAO term, it divides the visibility by that of the same slices with
  unobstructed horizons (`totalUnoccludedVisibility`). Without this, the sparse
  sampling darkens unoccluded surfaces that are oblique to the view direction.
- For the GTAO term, it pulls each sample's horizon toward the unobstructed
  limit by a quadratic falloff in view-space distance.
- It omits the paper's multi-bounce approximation, bent normals, and thickness
  heuristic.
- It applies the blended result as `color.rgb * pow(ao, intensity)`, with a
  user-controlled `intensity`.

## Scope

SSAO is limited to mesh surfaces because `MeshLayer`, `MultiscaleMeshLayer`, and
`SingleMeshLayer` supply a view-space normal via the three-argument `emit(color,
pickId, viewNormal)` form. Annotations are omitted from SSAO because they are
glyphs for which 3D shading makes little sense. Skeletons are omitted because
they are rendered as lines without the surface normals needed for SSAO. The
omitted types call the two-argument `emit(color, pickId)` form, which writes the
zero sentinel `vec4(0, 0, 0, 1)` to the NORMAL attachment. The SSAO shader
treats a zero-RGB normal as a no-AO sentinel, so those pixels render at full
brightness. Highlighted (hovered) mesh segments use the same zero-RGB sentinel
so they also render without darkening.

This limitation for annotations is enforced in the compositing stage, where the
shader skips the AO multiplication for any pixel whose NORMAL value is the
zero-RGB sentinel. The two-argument emit writes `vec4(0, 0, 0, 1)` to NORMAL;
alpha must be 1 here for the blend mode `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` to
fully overwrite the underlying mesh normal with the sentinel. The sentinel lands
at every annotation pixel (including explicitly translucent pixels and
anti-aliased edges), and annotation layers drawn with picking disabled (e.g.,
graphene's in-progress merge line) still write it. A consequence is that
translucent annotations also do not receive darkening at the covered pixels,
since the sentinel takes precedence over the underlying mesh's normal. In
practice, pixels affected this way should be limited. A fix could be to apply AO
to the COLOR buffer before annotations render.

Translucent meshes receive no AO. They render in the OIT/transparency pass,
after the SSAO pass, and the OIT emitter does not write NORMAL. The composite
then darkens each pixel by the AO of the opaque surface beneath it, so a
translucent mesh in front of an opaque mesh shows that mesh's shading.

SSAO is disabled in any perspective view that contains a volume-rendering
layer, and the view shows a one-time message saying so. The composite
multiplies the color buffer after the volume has been blended into it, so AO
would darken the volume too. Supporting both would require applying AO before
the transparency pass, at the cost of another color buffer. This is a known
limitation.

## Integration points

- **`perspective_view/panel.ts`**: Selects the `perspectivePanelEmitWithNormals`
  emitter when SSAO is enabled, inserts the SSAO passes between opaque geometry
  and OIT/transparency, modifies the final composite.
- **`mesh/frontend.ts`** and **`single_mesh/frontend.ts`**: `MeshShaderManager`
  and `SingleMeshShaderManager` add the `uViewNormalMatrix` uniform and
  `vViewNormal` varying, and call `emit(color, pickId, viewNormal)`. The normal
  is negated for back faces (`gl_FrontFacing`), so interiors seen through cut
  surfaces shade correctly.
- **`perspective_view/panel.ts` (`OffscreenTextures`)**: NORMAL = 3 added as
  4th color attachment (RGBA8).
- **Settings panel**: SSAO checkbox and intensity/radius/depth-cue sliders appear
  in the global Settings side panel via `ViewerSettingsPanel` in
  `ui/viewer_settings.ts`, backed by trackable properties on `Viewer`.

## Emitter variations

Layer fragment shaders emitting into the perspective panel call one of two
overloads via the `renderContext` emitter:

- `emit(color, pickId, viewNormal)` — opaque surfaces that should _receive_ AO.
  `viewNormal` is in view space (right-handed, camera looking down -Z), need not
  be unit length. Caller is responsible for the world→view normal transform.
- `emit(color, pickId)` — opaque skeletons, annotations, cross-section
  slices, etc. Internally writes the zero-RGB sentinel `(0, 0, 0)` to NORMAL
  with alpha = 1. The composite shader skips the AO multiply for those pixels.

Highlighted (hovered) mesh segments emit a zero-RGB sentinel from
`MeshShaderManager`'s vertex shader, gated by a `uHighlighted` uniform owned by
the mesh layer. Any other layer that wants to exclude fragments from AO can do
the same: emit a zero-RGB view normal. The OIT emitter accepts the three-argument
signature for source compatibility but discards the normal: transparent surfaces
do not contribute to opaque AO.

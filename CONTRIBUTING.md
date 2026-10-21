Want to contribute? Great! First, read this page (including the small print at the end).

### Before you contribute

Before we can use your code, you must sign the
[Google Individual Contributor License Agreement](https://cla.developers.google.com/about/google-individual)
(CLA), which you can do online. The CLA is necessary mainly because you own the
copyright to your changes, even after your contribution becomes part of our
codebase, so we need your permission to use and distribute your code. We also
need to be sure of various other things—for instance that you'll tell us if you
know that your code infringes on other people's patents. You don't have to sign
the CLA until after you've submitted your code for review and a member has
approved it, but you must do it before we can put your code into our codebase.
Before you start working on a larger contribution, you should get in touch with
us first through the issue tracker with your idea so that we can help out and
possibly guide you. Coordinating up front makes it much easier to avoid
frustration later on.

### Code reviews

All submissions, including submissions by project members, require review.

### Coding Style

For consistency, please ensure that all TypeScript/JavaScript files
are linted with `eslint` and formatted by `prettier`.

You can check for lint/format issues with:

```shell
npm run lint:check
npm run format:check
```

To reformat run:

```shell
npm run format:fix
```

To automatically apply safe lint fixes, run:

```shell
npm run lint:fix
```

Python code is linted and formatted using
[ruff](https://github.com/astral-sh/ruff) and typechecked using
[mypy](https://mypy-lang.org/). To verify, run:

```shell
pip install nox
nox -s lint format mypy
```

### Temporary skeleton WebGL diagnostic build

This checkout enables `DEBUG_SKELETON_DRAW` and disables `DEBUG_SKIP_3D_LINE_NODES` in
[rendering_diagnostics.ts](src/skeleton/rendering_diagnostics.ts) for investigating
Windows ANGLE/D3D11 draw-time shader compilation failures.

- Node circles are compiled, initialized, and drawn in all modes, including 3D
  **lines**, where they fill gaps at line joins. Normal transparency and picking
  passes are retained.
- Each skeleton edge/node draw checks WebGL errors and program/shader info logs.
  Console messages beginning `Skeleton WebGL draw diagnostic` include the view,
  pass, emitter, primitive, segment ID, alpha, mode, and complete GLSL sources.
  Errors preceding the draw are recorded separately. Repeated identical reports
  for the same program and pass are suppressed.
  Reports also include translated vertex/fragment shader source when
  `WEBGL_debug_shaders` is available and the context is not lost.
  `translatedShaderStatus` distinguishes an unavailable extension, a lost context,
  and a completed query. Translation output may be empty and may not include
  ANGLE's final draw-time specialization, so HLSL line numbers may not match it.
- The node shader now evaluates `getCircleColor` into a local before calling
  `emit`, rather than nesting the discard-containing helper inside the call.
  This is an unconfirmed compiler-workaround trial; circle clipping, alpha,
  transparency, and picking calculations are unchanged.
- To test, enable **Preserve log** in browser developer tools, open the failing
  state, and export the console log. Include browser version, GPU/driver details,
  and the active WebGL backend from `chrome://gpu` or Firefox `about:support`.
  Logs include segment IDs and shader source; inspect them before sharing.
- To compare against the node-skip workaround, set `DEBUG_SKIP_3D_LINE_NODES` to
  `true`, rebuild, and repeat with the same state. This skips node compilation,
  initialization, and drawing only in 3D **lines** mode.
  Driver logs may be unavailable after context loss; retained GLSL is still
  included.

These are diagnostic changes, not a confirmed fix. Set both switches to `false`
and rebuild to restore normal node rendering and remove per-draw diagnostic
queries before production use. Diagnostics deliberately consume WebGL errors and
add synchronous queries, so do not use this build to measure rendering performance.

### The small print

Contributions made by corporations are covered by a different agreement than
the one above, the
[Software Grant and Corporate Contributor License Agreement](https://cla.developers.google.com/about/google-corporate).

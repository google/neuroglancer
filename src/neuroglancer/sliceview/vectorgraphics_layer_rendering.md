# Vector Graphics Layer Rendering

The underlying data for vector graphics layers consists of a series of (x,y,z) coordinates
(points) that can define points, lines, or other arbitrary polygons. Currently, a vertex shader for rendering lines is implemented. Like image layer rendering,
the vector graphics rendering code is customizable by specifying GLSL fragment shader code. 

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 1.0, specified at <https://www.khronos.org/files/opengles_shading_language.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl/webgl-reference-card-1_0.pdf>.

## API

The default vector graphics shaders are setup to render a series of (x,y,z) coordinates (points) as a vector field. Points are stored in a `VectorGraphicsPointChunk` in the `vertexPositions` attribute as `x,y,z` triplets. Given two points `p0` and `p1`, a line between `p0` and `p1` is rendered by "pushing out" each point along the line in the positive and negative normal direction to that line to create a rectangle. The rectangle is then rendered as two triangles in the vertex shader. 

The fragment shader defines a color for each primitive (`vec3 color`) and does some antialiasing. The `feather` parameter (a floating point value between `0` and `1`) allows the user to control the amount of antialiasing. Large values for `feather` will result in more antialiasing (blurrier lines). The default `feather` value is 0.5.
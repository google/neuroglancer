This directory implements hash functions, hash sets, and hash maps that support efficient use from
both JavaScript and from WebGL shaders running on the GPU.  These are used to
perform [pseudo-random color mapping of uint64 object IDs](/src/neuroglancer/segment_color.ts),
highlighting of a set of object ids, and equivalence maps over object ids.

The design is heavily constrained by the limitations of WebGL 1.0 (OpenGL ES Shading Language 1.0) shaders:
- Due to the lack of support for integer arithmetic and texture operations, all computations must be
  performed with 24-bit-precision floating point operations subject to inconsistent rounding and
  unsafe optimizations.  This makes the implementation quite delicate.  Correctness on common
  platforms is verified by the extensive unit tests.  WebGL 2.0, with its support for integer
  operations, will allow for a simpler and likely more performant implementation.
- Looping (except for a constant number of iterations) is not permitted in WebGL shaders, which
  rules out many common hash table
  designs.  [Cuckoo hashing](https://en.wikipedia.org/wiki/Cuckoo_hashing) is used as an elegant
  solution, particularly since only lookup is supported on the GPU, and most of the complexity is in
  the insertion and deletion operations.
- Because 1-D textures are not supported by WebGL, the hash tables are arranged as 2-D arrays
  consistent with supported 2-D texture dimensions.
- For efficient implementation using only floating point operations, the hash function family is low
  quality, but is adequate in practice within Neuroglancer.  Additional rehashes that may occur due
  to the poor hash function quality are not paticularly performance sensitive.

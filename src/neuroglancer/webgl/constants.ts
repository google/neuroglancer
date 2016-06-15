/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This contains the WebGLRenderingContext constants defined in
 * https://www.khronos.org/registry/webgl/specs/latest/1.0/
 */

/* ClearBufferMask */
export const GL_DEPTH_BUFFER_BIT = 0x00000100;
export const GL_STENCIL_BUFFER_BIT = 0x00000400;
export const GL_COLOR_BUFFER_BIT = 0x00004000;

/* BeginMode */
export const GL_POINTS = 0x0000;
export const GL_LINES = 0x0001;
export const GL_LINE_LOOP = 0x0002;
export const GL_LINE_STRIP = 0x0003;
export const GL_TRIANGLES = 0x0004;
export const GL_TRIANGLE_STRIP = 0x0005;
export const GL_TRIANGLE_FAN = 0x0006;

/* AlphaFunction (not supported in ES20) */
/*      NEVER */
/*      LESS */
/*      EQUAL */
/*      LEQUAL */
/*      GREATER */
/*      NOTEQUAL */
/*      GEQUAL */
/*      ALWAYS */

/* BlendingFactorDest */
export const GL_ZERO = 0;
export const GL_ONE = 1;
export const GL_SRC_COLOR = 0x0300;
export const GL_ONE_MINUS_SRC_COLOR = 0x0301;
export const GL_SRC_ALPHA = 0x0302;
export const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
export const GL_DST_ALPHA = 0x0304;
export const GL_ONE_MINUS_DST_ALPHA = 0x0305;

/* BlendingFactorSrc */
/*      ZERO */
/*      ONE */
export const GL_DST_COLOR = 0x0306;
export const GL_ONE_MINUS_DST_COLOR = 0x0307;
export const GL_SRC_ALPHA_SATURATE = 0x0308;
/*      SRC_ALPHA */
/*      ONE_MINUS_SRC_ALPHA */
/*      DST_ALPHA */
/*      ONE_MINUS_DST_ALPHA */

/* BlendEquationSeparate */
export const GL_FUNC_ADD = 0x8006;
export const GL_BLEND_EQUATION = 0x8009;
export const GL_BLEND_EQUATION_RGB = 0x8009; /* same as BLEND_EQUATION */
export const GL_BLEND_EQUATION_ALPHA = 0x883D;

/* BlendSubtract */
export const GL_FUNC_SUBTRACT = 0x800A;
export const GL_FUNC_REVERSE_SUBTRACT = 0x800B;

/* Separate Blend Functions */
export const GL_BLEND_DST_RGB = 0x80C8;
export const GL_BLEND_SRC_RGB = 0x80C9;
export const GL_BLEND_DST_ALPHA = 0x80CA;
export const GL_BLEND_SRC_ALPHA = 0x80CB;
export const GL_CONSTANT_COLOR = 0x8001;
export const GL_ONE_MINUS_CONSTANT_COLOR = 0x8002;
export const GL_CONSTANT_ALPHA = 0x8003;
export const GL_ONE_MINUS_CONSTANT_ALPHA = 0x8004;
export const GL_BLEND_COLOR = 0x8005;

/* Buffer Objects */
export const GL_ARRAY_BUFFER = 0x8892;
export const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
export const GL_ARRAY_BUFFER_BINDING = 0x8894;
export const GL_ELEMENT_ARRAY_BUFFER_BINDING = 0x8895;

export const GL_STREAM_DRAW = 0x88E0;
export const GL_STATIC_DRAW = 0x88E4;
export const GL_DYNAMIC_DRAW = 0x88E8;

export const GL_BUFFER_SIZE = 0x8764;
export const GL_BUFFER_USAGE = 0x8765;

export const GL_CURRENT_VERTEX_ATTRIB = 0x8626;

/* CullFaceMode */
export const GL_FRONT = 0x0404;
export const GL_BACK = 0x0405;
export const GL_FRONT_AND_BACK = 0x0408;

/* DepthFunction */
/*      NEVER */
/*      LESS */
/*      EQUAL */
/*      LEQUAL */
/*      GREATER */
/*      NOTEQUAL */
/*      GEQUAL */
/*      ALWAYS */

/* EnableCap */
/* TEXTURE_2D */
export const GL_CULL_FACE = 0x0B44;
export const GL_BLEND = 0x0BE2;
export const GL_DITHER = 0x0BD0;
export const GL_STENCIL_TEST = 0x0B90;
export const GL_DEPTH_TEST = 0x0B71;
export const GL_SCISSOR_TEST = 0x0C11;
export const GL_POLYGON_OFFSET_FILL = 0x8037;
export const GL_SAMPLE_ALPHA_TO_COVERAGE = 0x809E;
export const GL_SAMPLE_COVERAGE = 0x80A0;

/* ErrorCode */
export const GL_NO_ERROR = 0;
export const GL_INVALID_ENUM = 0x0500;
export const GL_INVALID_VALUE = 0x0501;
export const GL_INVALID_OPERATION = 0x0502;
export const GL_OUT_OF_MEMORY = 0x0505;

/* FrontFaceDirection */
export const GL_CW = 0x0900;
export const GL_CCW = 0x0901;

/* GetPName */
export const GL_LINE_WIDTH = 0x0B21;
export const GL_ALIASED_POINT_SIZE_RANGE = 0x846D;
export const GL_ALIASED_LINE_WIDTH_RANGE = 0x846E;
export const GL_CULL_FACE_MODE = 0x0B45;
export const GL_FRONT_FACE = 0x0B46;
export const GL_DEPTH_RANGE = 0x0B70;
export const GL_DEPTH_WRITEMASK = 0x0B72;
export const GL_DEPTH_CLEAR_VALUE = 0x0B73;
export const GL_DEPTH_FUNC = 0x0B74;
export const GL_STENCIL_CLEAR_VALUE = 0x0B91;
export const GL_STENCIL_FUNC = 0x0B92;
export const GL_STENCIL_FAIL = 0x0B94;
export const GL_STENCIL_PASS_DEPTH_FAIL = 0x0B95;
export const GL_STENCIL_PASS_DEPTH_PASS = 0x0B96;
export const GL_STENCIL_REF = 0x0B97;
export const GL_STENCIL_VALUE_MASK = 0x0B93;
export const GL_STENCIL_WRITEMASK = 0x0B98;
export const GL_STENCIL_BACK_FUNC = 0x8800;
export const GL_STENCIL_BACK_FAIL = 0x8801;
export const GL_STENCIL_BACK_PASS_DEPTH_FAIL = 0x8802;
export const GL_STENCIL_BACK_PASS_DEPTH_PASS = 0x8803;
export const GL_STENCIL_BACK_REF = 0x8CA3;
export const GL_STENCIL_BACK_VALUE_MASK = 0x8CA4;
export const GL_STENCIL_BACK_WRITEMASK = 0x8CA5;
export const GL_VIEWPORT = 0x0BA2;
export const GL_SCISSOR_BOX = 0x0C10;
/*      SCISSOR_TEST */
export const GL_COLOR_CLEAR_VALUE = 0x0C22;
export const GL_COLOR_WRITEMASK = 0x0C23;
export const GL_UNPACK_ALIGNMENT = 0x0CF5;
export const GL_PACK_ALIGNMENT = 0x0D05;
export const GL_MAX_TEXTURE_SIZE = 0x0D33;
export const GL_MAX_VIEWPORT_DIMS = 0x0D3A;
export const GL_SUBPIXEL_BITS = 0x0D50;
export const GL_RED_BITS = 0x0D52;
export const GL_GREEN_BITS = 0x0D53;
export const GL_BLUE_BITS = 0x0D54;
export const GL_ALPHA_BITS = 0x0D55;
export const GL_DEPTH_BITS = 0x0D56;
export const GL_STENCIL_BITS = 0x0D57;
export const GL_POLYGON_OFFSET_UNITS = 0x2A00;
/*      POLYGON_OFFSET_FILL */
export const GL_POLYGON_OFFSET_FACTOR = 0x8038;
export const GL_TEXTURE_BINDING_2D = 0x8069;
export const GL_SAMPLE_BUFFERS = 0x80A8;
export const GL_SAMPLES = 0x80A9;
export const GL_SAMPLE_COVERAGE_VALUE = 0x80AA;
export const GL_SAMPLE_COVERAGE_INVERT = 0x80AB;

/* GetTextureParameter */
/*      TEXTURE_MAG_FILTER */
/*      TEXTURE_MIN_FILTER */
/*      TEXTURE_WRAP_S */
/*      TEXTURE_WRAP_T */

export const GL_COMPRESSED_TEXTURE_FORMATS = 0x86A3;

/* HintMode */
export const GL_DONT_CARE = 0x1100;
export const GL_FASTEST = 0x1101;
export const GL_NICEST = 0x1102;

/* HintTarget */
export const GL_GENERATE_MIPMAP_HINT = 0x8192;

/* DataType */
export const GL_BYTE = 0x1400;
export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_SHORT = 0x1402;
export const GL_UNSIGNED_SHORT = 0x1403;
export const GL_INT = 0x1404;
export const GL_UNSIGNED_INT = 0x1405;
export const GL_FLOAT = 0x1406;

/* PixelFormat */
export const GL_DEPTH_COMPONENT = 0x1902;
export const GL_ALPHA = 0x1906;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_LUMINANCE = 0x1909;
export const GL_LUMINANCE_ALPHA = 0x190A;

/* PixelType */
/*      UNSIGNED_BYTE */
export const GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
export const GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
export const GL_UNSIGNED_SHORT_5_6_5 = 0x8363;

/* Shaders */
export const GL_FRAGMENT_SHADER = 0x8B30;
export const GL_VERTEX_SHADER = 0x8B31;
export const GL_MAX_VERTEX_ATTRIBS = 0x8869;
export const GL_MAX_VERTEX_UNIFORM_VECTORS = 0x8DFB;
export const GL_MAX_VARYING_VECTORS = 0x8DFC;
export const GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8B4D;
export const GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8B4C;
export const GL_MAX_TEXTURE_IMAGE_UNITS = 0x8872;
export const GL_MAX_FRAGMENT_UNIFORM_VECTORS = 0x8DFD;
export const GL_SHADER_TYPE = 0x8B4F;
export const GL_DELETE_STATUS = 0x8B80;
export const GL_LINK_STATUS = 0x8B82;
export const GL_VALIDATE_STATUS = 0x8B83;
export const GL_ATTACHED_SHADERS = 0x8B85;
export const GL_ACTIVE_UNIFORMS = 0x8B86;
export const GL_ACTIVE_ATTRIBUTES = 0x8B89;
export const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;
export const GL_CURRENT_PROGRAM = 0x8B8D;

/* StencilFunction */
export const GL_NEVER = 0x0200;
export const GL_LESS = 0x0201;
export const GL_EQUAL = 0x0202;
export const GL_LEQUAL = 0x0203;
export const GL_GREATER = 0x0204;
export const GL_NOTEQUAL = 0x0205;
export const GL_GEQUAL = 0x0206;
export const GL_ALWAYS = 0x0207;

/* StencilOp */
/*      ZERO */
export const GL_KEEP = 0x1E00;
export const GL_REPLACE = 0x1E01;
export const GL_INCR = 0x1E02;
export const GL_DECR = 0x1E03;
export const GL_INVERT = 0x150A;
export const GL_INCR_WRAP = 0x8507;
export const GL_DECR_WRAP = 0x8508;

/* StringName */
export const GL_VENDOR = 0x1F00;
export const GL_RENDERER = 0x1F01;
export const GL_VERSION = 0x1F02;

/* TextureMagFilter */
export const GL_NEAREST = 0x2600;
export const GL_LINEAR = 0x2601;

/* TextureMinFilter */
/*      NEAREST */
/*      LINEAR */
export const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
export const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
export const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
export const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

/* TextureParameterName */
export const GL_TEXTURE_MAG_FILTER = 0x2800;
export const GL_TEXTURE_MIN_FILTER = 0x2801;
export const GL_TEXTURE_WRAP_S = 0x2802;
export const GL_TEXTURE_WRAP_T = 0x2803;

/* TextureTarget */
export const GL_TEXTURE_2D = 0x0DE1;
export const GL_TEXTURE = 0x1702;

export const GL_TEXTURE_CUBE_MAP = 0x8513;
export const GL_TEXTURE_BINDING_CUBE_MAP = 0x8514;
export const GL_TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
export const GL_TEXTURE_CUBE_MAP_NEGATIVE_X = 0x8516;
export const GL_TEXTURE_CUBE_MAP_POSITIVE_Y = 0x8517;
export const GL_TEXTURE_CUBE_MAP_NEGATIVE_Y = 0x8518;
export const GL_TEXTURE_CUBE_MAP_POSITIVE_Z = 0x8519;
export const GL_TEXTURE_CUBE_MAP_NEGATIVE_Z = 0x851A;
export const GL_MAX_CUBE_MAP_TEXTURE_SIZE = 0x851C;

/* TextureUnit */
export const GL_TEXTURE0 = 0x84C0;
export const GL_TEXTURE1 = 0x84C1;
export const GL_TEXTURE2 = 0x84C2;
export const GL_TEXTURE3 = 0x84C3;
export const GL_TEXTURE4 = 0x84C4;
export const GL_TEXTURE5 = 0x84C5;
export const GL_TEXTURE6 = 0x84C6;
export const GL_TEXTURE7 = 0x84C7;
export const GL_TEXTURE8 = 0x84C8;
export const GL_TEXTURE9 = 0x84C9;
export const GL_TEXTURE10 = 0x84CA;
export const GL_TEXTURE11 = 0x84CB;
export const GL_TEXTURE12 = 0x84CC;
export const GL_TEXTURE13 = 0x84CD;
export const GL_TEXTURE14 = 0x84CE;
export const GL_TEXTURE15 = 0x84CF;
export const GL_TEXTURE16 = 0x84D0;
export const GL_TEXTURE17 = 0x84D1;
export const GL_TEXTURE18 = 0x84D2;
export const GL_TEXTURE19 = 0x84D3;
export const GL_TEXTURE20 = 0x84D4;
export const GL_TEXTURE21 = 0x84D5;
export const GL_TEXTURE22 = 0x84D6;
export const GL_TEXTURE23 = 0x84D7;
export const GL_TEXTURE24 = 0x84D8;
export const GL_TEXTURE25 = 0x84D9;
export const GL_TEXTURE26 = 0x84DA;
export const GL_TEXTURE27 = 0x84DB;
export const GL_TEXTURE28 = 0x84DC;
export const GL_TEXTURE29 = 0x84DD;
export const GL_TEXTURE30 = 0x84DE;
export const GL_TEXTURE31 = 0x84DF;
export const GL_ACTIVE_TEXTURE = 0x84E0;

/* TextureWrapMode */
export const GL_REPEAT = 0x2901;
export const GL_CLAMP_TO_EDGE = 0x812F;
export const GL_MIRRORED_REPEAT = 0x8370;

/* Uniform Types */
export const GL_FLOAT_VEC2 = 0x8B50;
export const GL_FLOAT_VEC3 = 0x8B51;
export const GL_FLOAT_VEC4 = 0x8B52;
export const GL_INT_VEC2 = 0x8B53;
export const GL_INT_VEC3 = 0x8B54;
export const GL_INT_VEC4 = 0x8B55;
export const GL_BOOL = 0x8B56;
export const GL_BOOL_VEC2 = 0x8B57;
export const GL_BOOL_VEC3 = 0x8B58;
export const GL_BOOL_VEC4 = 0x8B59;
export const GL_FLOAT_MAT2 = 0x8B5A;
export const GL_FLOAT_MAT3 = 0x8B5B;
export const GL_FLOAT_MAT4 = 0x8B5C;
export const GL_SAMPLER_2D = 0x8B5E;
export const GL_SAMPLER_CUBE = 0x8B60;

/* Vertex Arrays */
export const GL_VERTEX_ATTRIB_ARRAY_ENABLED = 0x8622;
export const GL_VERTEX_ATTRIB_ARRAY_SIZE = 0x8623;
export const GL_VERTEX_ATTRIB_ARRAY_STRIDE = 0x8624;
export const GL_VERTEX_ATTRIB_ARRAY_TYPE = 0x8625;
export const GL_VERTEX_ATTRIB_ARRAY_NORMALIZED = 0x886A;
export const GL_VERTEX_ATTRIB_ARRAY_POINTER = 0x8645;
export const GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING = 0x889F;

/* Read Format */
export const GL_IMPLEMENTATION_COLOR_READ_TYPE = 0x8B9A;
export const GL_IMPLEMENTATION_COLOR_READ_FORMAT = 0x8B9B;

/* Shader Source */
export const GL_COMPILE_STATUS = 0x8B81;

/* Shader Precision-Specified Types */
export const GL_LOW_FLOAT = 0x8DF0;
export const GL_MEDIUM_FLOAT = 0x8DF1;
export const GL_HIGH_FLOAT = 0x8DF2;
export const GL_LOW_INT = 0x8DF3;
export const GL_MEDIUM_INT = 0x8DF4;
export const GL_HIGH_INT = 0x8DF5;

/* Framebuffer Object. */
export const GL_FRAMEBUFFER = 0x8D40;
export const GL_RENDERBUFFER = 0x8D41;

export const GL_RGBA4 = 0x8056;
export const GL_RGB5_A1 = 0x8057;
export const GL_RGB565 = 0x8D62;
export const GL_DEPTH_COMPONENT16 = 0x81A5;
export const GL_STENCIL_INDEX = 0x1901;
export const GL_STENCIL_INDEX8 = 0x8D48;
export const GL_DEPTH_STENCIL = 0x84F9;

export const GL_RENDERBUFFER_WIDTH = 0x8D42;
export const GL_RENDERBUFFER_HEIGHT = 0x8D43;
export const GL_RENDERBUFFER_INTERNAL_FORMAT = 0x8D44;
export const GL_RENDERBUFFER_RED_SIZE = 0x8D50;
export const GL_RENDERBUFFER_GREEN_SIZE = 0x8D51;
export const GL_RENDERBUFFER_BLUE_SIZE = 0x8D52;
export const GL_RENDERBUFFER_ALPHA_SIZE = 0x8D53;
export const GL_RENDERBUFFER_DEPTH_SIZE = 0x8D54;
export const GL_RENDERBUFFER_STENCIL_SIZE = 0x8D55;

export const GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE = 0x8CD0;
export const GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME = 0x8CD1;
export const GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL = 0x8CD2;
export const GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE = 0x8CD3;

export const GL_COLOR_ATTACHMENT0 = 0x8CE0;
export const GL_DEPTH_ATTACHMENT = 0x8D00;
export const GL_STENCIL_ATTACHMENT = 0x8D20;
export const GL_DEPTH_STENCIL_ATTACHMENT = 0x821A;

export const GL_NONE = 0;

export const GL_FRAMEBUFFER_COMPLETE = 0x8CD5;
export const GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT = 0x8CD6;
export const GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT = 0x8CD7;
export const GL_FRAMEBUFFER_INCOMPLETE_DIMENSIONS = 0x8CD9;
export const GL_FRAMEBUFFER_UNSUPPORTED = 0x8CDD;

export const GL_FRAMEBUFFER_BINDING = 0x8CA6;
export const GL_RENDERBUFFER_BINDING = 0x8CA7;
export const GL_MAX_RENDERBUFFER_SIZE = 0x84E8;

export const GL_INVALID_FRAMEBUFFER_OPERATION = 0x0506;

/* WebGL-specific enums */
export const GL_UNPACK_FLIP_Y_WEBGL = 0x9240;
export const GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
export const GL_CONTEXT_LOST_WEBGL = 0x9242;
export const GL_UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243;
export const GL_BROWSER_DEFAULT_WEBGL = 0x9244;
